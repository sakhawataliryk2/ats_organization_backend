// models/placement.js
const { allocateRecordNumber, releaseRecordNumber, runMigrationIfNeeded } = require('../services/recordNumberService');

class Placement {
    constructor(pool) {
        this.pool = pool;
    }

    // Initialize the placements  if it doesn't exist
    async initTable() {
        let client;
        try {
            console.log('Initializing placements table if needed...');
            client = await this.pool.connect();

            // Ensure reusable record number infrastructure (including placement_record_number_seq) exists
            await runMigrationIfNeeded(client);

            await client.query(`
                CREATE TABLE IF NOT EXISTS placements (
                    id SERIAL PRIMARY KEY,
                    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                    job_seeker_id INTEGER NOT NULL REFERENCES job_seekers(id) ON DELETE CASCADE,
                    placement_type VARCHAR(50) NOT NULL DEFAULT 'Contract',
                    status VARCHAR(50) NOT NULL DEFAULT 'Pending',
                    start_date DATE NOT NULL,
                    internal_email_notification TEXT,
                    -- Permanent Employment Info
                    salary NUMERIC,
                    placement_fee_percent NUMERIC,
                    placement_fee_flat NUMERIC,
                    days_guaranteed INTEGER,
                    -- Contract Employment Info
                    hours_per_day VARCHAR(50),
                    hours_of_operation VARCHAR(100),
                    -- Pay Rate Information
                    pay_rate NUMERIC,
                    pay_rate_checked BOOLEAN DEFAULT false,
                    effective_date DATE,
                    effective_date_checked BOOLEAN DEFAULT false,
                    overtime_exemption BOOLEAN DEFAULT false,
                    created_by INTEGER REFERENCES users(id),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    custom_fields JSONB,
                    archived_at TIMESTAMP,
                    archive_reason VARCHAR(50),
                    record_number INTEGER
                )
            `);

            // Add placement_type column if it doesn't exist (for existing installations)
            await client.query(`
                ALTER TABLE placements 
                ADD COLUMN IF NOT EXISTS placement_type VARCHAR(50) DEFAULT 'Contract'
            `);

            // Add custom_fields column if it doesn't exist (for existing installations)
            await client.query(`
                ALTER TABLE placements 
                ADD COLUMN IF NOT EXISTS custom_fields JSONB
            `);
            // Add end_date column if it doesn't exist (for existing installations)
            await client.query(`
                ALTER TABLE placements 
                ADD COLUMN IF NOT EXISTS end_date DATE
            `);
            // Add organization_id column (filled from job; sent from frontend)
            await client.query(`
                ALTER TABLE placements 
                ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE
            `);

            // Add archived_at and archive_reason columns if they don't exist (for existing tables)
            await client.query(`
                ALTER TABLE placements ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP
            `);
            await client.query(`
                ALTER TABLE placements ADD COLUMN IF NOT EXISTS archive_reason VARCHAR(50)
            `);
            await client.query(`
                ALTER TABLE placements ADD COLUMN IF NOT EXISTS record_number INTEGER
            `);

            // Backfill record_number for existing rows that predate allocation
            await client.query(`
                WITH ordered AS (
                    SELECT
                        id,
                        ROW_NUMBER() OVER (ORDER BY id)
                        + COALESCE((SELECT MAX(record_number) FROM placements WHERE record_number IS NOT NULL), 0) AS rn
                    FROM placements
                    WHERE record_number IS NULL
                )
                UPDATE placements p
                SET record_number = ordered.rn
                FROM ordered
                WHERE p.id = ordered.id
            `);

            // Enforce uniqueness + non-null going forward
            await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_placements_record_number ON placements (record_number)`);
            await client.query(`ALTER TABLE placements ALTER COLUMN record_number SET NOT NULL`);

            // Ensure sequence continues from current max
            await client.query(`SELECT setval('placement_record_number_seq', (SELECT COALESCE(MAX(record_number), 0) FROM placements))`);

            // Create indexes for better query performance
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_placements_job_id ON placements(job_id)
            `);
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_placements_job_seeker_id ON placements(job_seeker_id)
            `);
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_placements_status ON placements(status)
            `);
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_placements_organization_id ON placements(organization_id)
            `);

            // Ensure organization_id uses ON DELETE CASCADE for existing installations
            await client.query(`
                ALTER TABLE placements
                DROP CONSTRAINT IF EXISTS placements_organization_id_fkey,
                ADD CONSTRAINT placements_organization_id_fkey
                    FOREIGN KEY (organization_id)
                    REFERENCES organizations(id)
                    ON DELETE CASCADE
            `);

            // Create placement history table (same structure as job_history, etc.)
            await client.query(`
                CREATE TABLE IF NOT EXISTS placement_history (
                    id SERIAL PRIMARY KEY,
                    placement_id INTEGER NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
                    action VARCHAR(50) NOT NULL,
                    details JSONB,
                    performed_by INTEGER REFERENCES users(id),
                    performed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_placement_history_placement_id ON placement_history(placement_id)
            `);

            // Placement notes table (same structure as organization_notes)
            await client.query(`
                CREATE TABLE IF NOT EXISTS placement_notes (
                    id SERIAL PRIMARY KEY,
                    placement_id INTEGER NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
                    text TEXT NOT NULL,
                    action VARCHAR(255),
                    about_references JSONB,
                    created_by INTEGER REFERENCES users(id),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_placement_notes_placement_id ON placement_notes(placement_id)
            `);

            console.log('✅ Placements table initialized successfully');
            return true;
        } catch (error) {
            console.error('❌ Error initializing placements table:', error.message);
            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // Resolve value from custom_fields using multiple possible labels (admin can use different names)
    _resolveFromCustomFields(cf, labelVariants) {
        if (!cf || typeof cf !== 'object') return undefined;
        for (const label of labelVariants) {
            const v = cf[label];
            if (v !== undefined && v !== null && String(v).trim() !== '') return v;
        }
        return undefined;
    }

    // Create a new placement
    async create(placementData) {
        const finalCustomFields = placementData.custom_fields || placementData.customFields;
        const cf = (typeof finalCustomFields === 'object' && !Array.isArray(finalCustomFields) && finalCustomFields !== null)
            ? finalCustomFields
            : (typeof finalCustomFields === 'string' ? (() => { try { return JSON.parse(finalCustomFields); } catch { return {}; } })() : {});

        // Resolve job_id, job_seeker_id, start_date, organization_id - from top-level first, else from custom_fields
        let job_id = placementData.job_id ?? placementData.jobId ?? this._resolveFromCustomFields(cf, ['Job ID', 'Job', 'job_id']);
        let job_seeker_id = placementData.job_seeker_id ?? this._resolveFromCustomFields(cf, ['Job Seeker ID', 'Job Seeker', 'Candidate', 'job_seeker_id']);
        let start_date = placementData.start_date ?? this._resolveFromCustomFields(cf, ['Start Date', 'start_date']);
        let organization_id = placementData.organization_id ?? this._resolveFromCustomFields(cf, ['Organization', 'Organization Name', 'organization_id']);

        // Normalize IDs to numbers where needed
        if (job_id != null) { const n = Number(job_id); job_id = !isNaN(n) ? n : null; }
        if (job_seeker_id != null) { const n = Number(job_seeker_id); job_seeker_id = !isNaN(n) ? n : null; }
        if (organization_id != null) { const n = Number(organization_id); organization_id = !isNaN(n) ? n : null; }

        // Normalize start_date to YYYY-MM-DD if in mm/dd/yyyy from custom_fields
        if (start_date && typeof start_date === 'string') {
            const m = start_date.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
            if (m) start_date = `${m[3]}-${m[1]}-${m[2]}`;
        }

        const {
            placement_type,
            status,
            internal_email_notification,
            salary,
            placement_fee_percent,
            placement_fee_flat,
            days_guaranteed,
            hours_per_day,
            hours_of_operation,
            pay_rate,
            pay_rate_checked,
            effective_date,
            effective_date_checked,
            overtime_exemption,
            created_by,
            custom_fields
        } = placementData;

        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            // Allocate business record number (display-only)
            const recordNumber = await allocateRecordNumber(client, 'placement');

            // Handle custom_fields - accept both customFields and custom_fields, convert object to JSON string for JSONB
            let customFieldsJson = null;
            
            if (finalCustomFields) {
                if (typeof finalCustomFields === 'string') {
                    // It's already a string, validate it's valid JSON
                    try {
                        JSON.parse(finalCustomFields);
                        customFieldsJson = finalCustomFields;
                    } catch (e) {
                        console.error("Invalid JSON string in custom_fields:", e);
                        customFieldsJson = null;
                    }
                } else if (typeof finalCustomFields === 'object' && !Array.isArray(finalCustomFields) && finalCustomFields !== null) {
                    // It's a valid object, stringify it for JSONB storage
                    try {
                        customFieldsJson = JSON.stringify(finalCustomFields);
                    } catch (e) {
                        console.error("Error stringifying custom_fields:", e);
                        customFieldsJson = null;
                    }
                }
            }

            console.log("Custom fields processing for placement:");
            console.log("  - Received custom_fields:", finalCustomFields);
            console.log("  - Processed customFieldsJson:", customFieldsJson);

            const insertQuery = `
                INSERT INTO placements (
                    job_id, job_seeker_id, organization_id, placement_type, status, start_date, internal_email_notification,
                    salary, placement_fee_percent, placement_fee_flat, days_guaranteed,
                    hours_per_day, hours_of_operation,
                    pay_rate, pay_rate_checked, effective_date, effective_date_checked,
                    overtime_exemption, created_by, custom_fields, record_number, created_at, updated_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, NOW(), NOW())
                RETURNING *
            `;

            const values = [
                job_id,
                job_seeker_id,
                organization_id || null,
                placement_type || 'Contract',
                status || 'Pending',
                start_date,
                internal_email_notification || null,
                salary || null,
                placement_fee_percent || null,
                placement_fee_flat || null,
                days_guaranteed || null,
                hours_per_day || null,
                hours_of_operation || null,
                pay_rate || null,
                pay_rate_checked || false,
                effective_date || null,
                effective_date_checked || false,
                overtime_exemption || false,
                created_by || null,
                customFieldsJson,
                recordNumber
            ];

            const result = await client.query(insertQuery, values);
            const placementRow = result.rows[0];

            // Add history entry for CREATE
            const historyQuery = `
                INSERT INTO placement_history (placement_id, action, details, performed_by)
                VALUES ($1, $2, $3, $4)
            `;
            await client.query(historyQuery, [
                placementRow.id,
                'CREATE',
                JSON.stringify(placementData),
                created_by || null
            ]);

            await client.query('COMMIT');

            return this.formatPlacement(placementRow);
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error creating placement:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    // Get all placements
    async getAll(userId = null) {
        const client = await this.pool.connect();
        try {
            let query = `
                SELECT 
                    p.*,
                    j.job_title,
                    j.status as job_status,
                    js.first_name,
                    js.last_name,
                    js.email as job_seeker_email,
                    js.phone as job_seeker_phone,
                    u.name as created_by_name,
                    o.name as organization_name
                FROM placements p
                LEFT JOIN jobs j ON p.job_id = j.id
                LEFT JOIN job_seekers js ON p.job_seeker_id = js.id
                LEFT JOIN users u ON p.created_by = u.id
                LEFT JOIN organizations o ON COALESCE(p.organization_id, j.organization_id) = o.id
            `;

            const params = [];
            if (userId) {
                query += ` WHERE p.created_by = $1`;
                params.push(userId);
            }

            query += ` ORDER BY p.created_at DESC`;

            const result = await client.query(query, params);
            return result.rows.map(row => this.formatPlacement(row));
        } catch (error) {
            console.error('Error getting placements:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    // Get placement by ID
    async findById(id) {
        const client = await this.pool.connect();
        try {
            const query = `
                SELECT 
                    p.*,
                    j.job_title,
                    j.status as job_status,
                    js.first_name,
                    js.last_name,
                    js.email as job_seeker_email,
                    js.phone as job_seeker_phone,
                    u.name as created_by_name,
                    o.name as organization_name
                FROM placements p
                LEFT JOIN jobs j ON p.job_id = j.id
                LEFT JOIN job_seekers js ON p.job_seeker_id = js.id
                LEFT JOIN users u ON p.created_by = u.id
                LEFT JOIN organizations o ON COALESCE(p.organization_id, j.organization_id) = o.id
                WHERE p.id = $1
            `;
            const result = await client.query(query, [id]);
            return result.rows.length > 0 ? this.formatPlacement(result.rows[0]) : null;
        } catch (error) {
            console.error('Error finding placement by ID:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    // Get placements by job ID
    async findByJobId(jobId) {
        const client = await this.pool.connect();
        try {
            const query = `
                SELECT 
                    p.*,
                    j.job_title,
                    j.status as job_status,
                    js.first_name,
                    js.last_name,
                    js.email as job_seeker_email,
                    js.phone as job_seeker_phone,
                    u.name as created_by_name,
                    o.name as organization_name
                FROM placements p
                LEFT JOIN jobs j ON p.job_id = j.id
                LEFT JOIN job_seekers js ON p.job_seeker_id = js.id
                LEFT JOIN users u ON p.created_by = u.id
                LEFT JOIN organizations o ON COALESCE(p.organization_id, j.organization_id) = o.id
                WHERE p.job_id = $1
                ORDER BY p.created_at DESC
            `;
            const result = await client.query(query, [jobId]);
            return result.rows.map(row => this.formatPlacement(row));
        } catch (error) {
            console.error('Error finding placements by job ID:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    // Get placements by job seeker ID
    async findByJobSeekerId(jobSeekerId) {
        const client = await this.pool.connect();
        try {
            const query = `
                SELECT 
                    p.*,
                    j.job_title,
                    j.status as job_status,
                    js.first_name,
                    js.last_name,
                    js.email as job_seeker_email,
                    js.phone as job_seeker_phone,
                    u.name as created_by_name,
                    o.name as organization_name
                FROM placements p
                LEFT JOIN jobs j ON p.job_id = j.id
                LEFT JOIN job_seekers js ON p.job_seeker_id = js.id
                LEFT JOIN users u ON p.created_by = u.id
                LEFT JOIN organizations o ON COALESCE(p.organization_id, j.organization_id) = o.id
                WHERE p.job_seeker_id = $1
                ORDER BY p.created_at DESC
            `;
            const result = await client.query(query, [jobSeekerId]);
            return result.rows.map(row => this.formatPlacement(row));
        } catch (error) {
            console.error('Error finding placements by job seeker ID:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    // Get placements by organization ID (defaults to status = 'Approved')
    async findByOrganizationId(organizationId, userId = null, status = 'Approved') {
        const client = await this.pool.connect();
        try {
            let query = `
                SELECT
                    p.*,
                    j.job_title,
                    j.status AS job_status,
                    js.first_name,
                    js.last_name,
                    js.email AS job_seeker_email,
                    js.phone AS job_seeker_phone,
                    u.name AS created_by_name,
                    o.name AS organization_name
                FROM placements p
                LEFT JOIN jobs j ON p.job_id = j.id
                LEFT JOIN job_seekers js ON p.job_seeker_id = js.id
                LEFT JOIN users u ON p.created_by = u.id
                LEFT JOIN organizations o ON COALESCE(p.organization_id, j.organization_id) = o.id
                WHERE COALESCE(p.organization_id, j.organization_id) = $1
            `;
            const params = [organizationId];
            if (status) {
                query += ` AND p.status = $${params.length + 1}`;
                params.push(status);
            }
            if (userId) {
                query += ` AND p.created_by = $${params.length + 1}`;
                params.push(userId);
            }
            query += ` ORDER BY p.start_date DESC, p.created_at DESC`;
            const result = await client.query(query, params);
            return result.rows.map((row) => this.formatPlacement(row));
        } catch (error) {
            console.error('Error finding placements by organization ID:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    // Get distinct organization IDs that have at least one placement with status = 'Approved'
    async findOrganizationIdsWithApprovedPlacements(userId = null) {
        const client = await this.pool.connect();
        try {
            let query = `
                SELECT DISTINCT COALESCE(p.organization_id, j.organization_id) AS org_id
                FROM placements p
                LEFT JOIN jobs j ON p.job_id = j.id
                WHERE p.status = $1
                  AND COALESCE(p.organization_id, j.organization_id) IS NOT NULL
            `;
            const params = ['Approved'];
            if (userId) {
                query += ` AND p.created_by = $2`;
                params.push(userId);
            }
            query += ` ORDER BY org_id`;
            const result = await client.query(query, params);
            return result.rows.map((row) => row.org_id).filter(Boolean);
        } catch (error) {
            console.error('Error finding organization IDs with approved placements:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    // Update placement
    async update(id, placementData, userId = null) {
        const {
            organization_id,
            placement_type,
            status,
            start_date,
            end_date,
            internal_email_notification,
            salary,
            placement_fee_percent,
            placement_fee_flat,
            days_guaranteed,
            hours_per_day,
            hours_of_operation,
            pay_rate,
            pay_rate_checked,
            effective_date,
            effective_date_checked,
            overtime_exemption,
            custom_fields
        } = placementData;

        // Convert empty strings to null for numeric fields (PostgreSQL NUMERIC rejects '')
        const toNum = (v) => {
            if (v === '' || v === undefined || v === null) return null;
            const n = parseFloat(v);
            return Number.isNaN(n) ? null : n;
        };
        const toInt = (v) => {
            if (v === '' || v === undefined || v === null) return null;
            const n = parseInt(v, 10);
            return Number.isNaN(n) ? null : n;
        };
        const salaryVal = toNum(salary);
        const placementFeePercentVal = toNum(placement_fee_percent);
        const placementFeeFlatVal = toNum(placement_fee_flat);
        const daysGuaranteedVal = toInt(days_guaranteed);
        const payRateVal = toNum(pay_rate);

        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            // Get current state for history (before update)
            const oldResult = await client.query('SELECT * FROM placements WHERE id = $1', [id]);
            const oldState = oldResult.rows[0] || null;

            // Handle custom_fields - merge with existing instead of replacing
            let customFieldsJson = undefined; // Use undefined so COALESCE doesn't update if not provided
            const finalCustomFields = custom_fields !== undefined ? custom_fields : placementData.customFields;
            
            if (finalCustomFields !== undefined) {
                if (finalCustomFields === null) {
                    customFieldsJson = null;
                } else {
                    try {
                        // Get existing custom_fields from database
                        let existingCustomFields = {};
                        if (oldState && oldState.custom_fields) {
                            existingCustomFields = typeof oldState.custom_fields === 'string'
                                ? JSON.parse(oldState.custom_fields || '{}')
                                : (oldState.custom_fields || {});
                        }

                        // Parse the incoming custom fields
                        let updateCustomFields = {};
                        if (typeof finalCustomFields === 'string') {
                            updateCustomFields = JSON.parse(finalCustomFields);
                        } else if (typeof finalCustomFields === 'object' && !Array.isArray(finalCustomFields)) {
                            updateCustomFields = finalCustomFields;
                        }

                        // Merge existing with new custom fields (new fields override existing ones)
                        const mergedCustomFields = { ...existingCustomFields, ...updateCustomFields };
                        
                        // Stringify for JSONB storage
                        customFieldsJson = JSON.stringify(mergedCustomFields);
                    } catch (e) {
                        console.error("Error processing custom_fields:", e);
                        // If merging fails, try to use the incoming data as-is
                        if (typeof finalCustomFields === 'string') {
                            customFieldsJson = finalCustomFields;
                        } else if (typeof finalCustomFields === 'object' && !Array.isArray(finalCustomFields)) {
                            customFieldsJson = JSON.stringify(finalCustomFields);
                        } else {
                            customFieldsJson = null;
                        }
                    }
                }
            }

            // Build update query dynamically based on whether custom_fields is provided
            let updateQuery;
            let values;
            
            const orgIdVal = organization_id === undefined || organization_id === '' ? undefined : (organization_id === null ? null : parseInt(organization_id, 10));
            const orgIdParam = orgIdVal === undefined ? null : orgIdVal;

            if (customFieldsJson !== undefined) {
                updateQuery = `
                    UPDATE placements
                    SET 
                        organization_id = COALESCE($1, organization_id),
                        placement_type = COALESCE($19, placement_type),
                        status = COALESCE($2, status),
                        start_date = COALESCE($3, start_date),
                        end_date = COALESCE($4, end_date),
                        internal_email_notification = COALESCE($5, internal_email_notification),
                        salary = COALESCE($6, salary),
                        placement_fee_percent = COALESCE($7, placement_fee_percent),
                        placement_fee_flat = COALESCE($8, placement_fee_flat),
                        days_guaranteed = COALESCE($9, days_guaranteed),
                        hours_per_day = COALESCE($10, hours_per_day),
                        hours_of_operation = COALESCE($11, hours_of_operation),
                        pay_rate = COALESCE($12, pay_rate),
                        pay_rate_checked = COALESCE($13, pay_rate_checked),
                        effective_date = COALESCE($14, effective_date),
                        effective_date_checked = COALESCE($15, effective_date_checked),
                        overtime_exemption = COALESCE($16, overtime_exemption),
                        custom_fields = $17,
                        updated_at = NOW()
                    WHERE id = $18
                    RETURNING *
                `;
                values = [
                    orgIdParam,
                    status,
                    start_date,
                    end_date === '' ? null : end_date,
                    internal_email_notification,
                    salaryVal,
                    placementFeePercentVal,
                    placementFeeFlatVal,
                    daysGuaranteedVal,
                    hours_per_day,
                    hours_of_operation,
                    payRateVal,
                    pay_rate_checked,
                    effective_date,
                    effective_date_checked,
                    overtime_exemption,
                    customFieldsJson,
                    id,
                    placement_type
                ];
            } else {
                updateQuery = `
                    UPDATE placements
                    SET 
                        organization_id = COALESCE($1, organization_id),
                        placement_type = COALESCE($18, placement_type),
                        status = COALESCE($2, status),
                        start_date = COALESCE($3, start_date),
                        end_date = COALESCE($4, end_date),
                        internal_email_notification = COALESCE($5, internal_email_notification),
                        salary = COALESCE($6, salary),
                        placement_fee_percent = COALESCE($7, placement_fee_percent),
                        placement_fee_flat = COALESCE($8, placement_fee_flat),
                        days_guaranteed = COALESCE($9, days_guaranteed),
                        hours_per_day = COALESCE($10, hours_per_day),
                        hours_of_operation = COALESCE($11, hours_of_operation),
                        pay_rate = COALESCE($12, pay_rate),
                        pay_rate_checked = COALESCE($13, pay_rate_checked),
                        effective_date = COALESCE($14, effective_date),
                        effective_date_checked = COALESCE($15, effective_date_checked),
                        overtime_exemption = COALESCE($16, overtime_exemption),
                        updated_at = NOW()
                    WHERE id = $17
                    RETURNING *
                `;
                values = [
                    orgIdParam,
                    status,
                    start_date,
                    end_date === '' ? null : end_date,
                    internal_email_notification,
                    salaryVal,
                    placementFeePercentVal,
                    placementFeeFlatVal,
                    daysGuaranteedVal,
                    hours_per_day,
                    hours_of_operation,
                    payRateVal,
                    pay_rate_checked,
                    effective_date,
                    effective_date_checked,
                    overtime_exemption,
                    id,
                    placement_type
                ];
            }

            const result = await client.query(updateQuery, values);
            const updatedRow = result.rows[0];

            if (updatedRow && oldState) {
                // Add history entry for UPDATE
                const historyQuery = `
                    INSERT INTO placement_history (placement_id, action, details, performed_by)
                    VALUES ($1, $2, $3, $4)
                `;
                await client.query(historyQuery, [
                    id,
                    'UPDATE',
                    JSON.stringify({ before: oldState, after: updatedRow }),
                    userId || oldState.created_by
                ]);
            }

            await client.query('COMMIT');

            return updatedRow ? this.formatPlacement(updatedRow) : null;
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error updating placement:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    // Delete placement
    async delete(id, userId = null) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const getQuery = 'SELECT * FROM placements WHERE id = $1';
            const getResult = await client.query(getQuery, [id]);
            const placement = getResult.rows[0];

            if (placement) {
                // Add history entry before deleting
                const historyQuery = `
                    INSERT INTO placement_history (placement_id, action, details, performed_by)
                    VALUES ($1, $2, $3, $4)
                `;
                await client.query(historyQuery, [
                    id,
                    'DELETE',
                    JSON.stringify(placement),
                    userId || placement.created_by
                ]);

                // Release record_number back to pool for reuse
                if (placement.record_number != null) {
                    await releaseRecordNumber(client, 'placement', placement.record_number);
                }
            }

            const deleteQuery = 'DELETE FROM placements WHERE id = $1 RETURNING *';
            const result = await client.query(deleteQuery, [id]);

            await client.query('COMMIT');
            return result.rows.length > 0 ? this.formatPlacement(result.rows[0]) : null;
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error deleting placement:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    // Get history for a placement
    async getHistory(placementId) {
        const client = await this.pool.connect();
        try {
            const query = `
                SELECT h.*, u.name as performed_by_name
                FROM placement_history h
                LEFT JOIN users u ON h.performed_by = u.id
                WHERE h.placement_id = $1
                ORDER BY h.performed_at DESC
            `;
            const result = await client.query(query, [placementId]);
            return result.rows;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Add a note to a placement (same pattern as organization)
    async addNote(placementId, text, userId, action = null, aboutReferences = null) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            let aboutReferencesJson = null;
            if (aboutReferences) {
                if (typeof aboutReferences === 'string') {
                    try {
                        const parsed = JSON.parse(aboutReferences);
                        aboutReferencesJson = Array.isArray(parsed) ? parsed : [parsed];
                    } catch (e) {
                        aboutReferencesJson = aboutReferences;
                    }
                } else if (Array.isArray(aboutReferences)) {
                    aboutReferencesJson = aboutReferences;
                } else if (typeof aboutReferences === 'object') {
                    aboutReferencesJson = [aboutReferences];
                }
            }

            const noteQuery = `
                INSERT INTO placement_notes (placement_id, text, action, about_references, created_by)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING *
            `;
            const noteResult = await client.query(noteQuery, [
                placementId,
                text,
                action,
                aboutReferencesJson ? JSON.stringify(aboutReferencesJson) : null,
                userId
            ]);

            const historyQuery = `
                INSERT INTO placement_history (placement_id, action, details, performed_by)
                VALUES ($1, $2, $3, $4)
            `;
            await client.query(historyQuery, [
                placementId,
                'ADD_NOTE',
                JSON.stringify({ noteId: noteResult.rows[0].id, text }),
                userId
            ]);

            await client.query('COMMIT');
            return noteResult.rows[0];
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async getNotes(placementId) {
        const client = await this.pool.connect();
        try {
            const query = `
                SELECT n.*, u.name as created_by_name
                FROM placement_notes n
                LEFT JOIN users u ON n.created_by = u.id
                WHERE n.placement_id = $1
                ORDER BY n.created_at DESC
            `;
            const result = await client.query(query, [placementId]);
            return result.rows.map((row) => {
                if (row.about_references && typeof row.about_references === 'string') {
                    try {
                        row.about_references = JSON.parse(row.about_references);
                    } catch (e) {}
                }
                return row;
            });
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Format placement data for response
    formatPlacement(row) {
        if (!row) return null;

        // Parse custom_fields if it's a string
        let customFields = null;
        if (row.custom_fields) {
            if (typeof row.custom_fields === 'string') {
                try {
                    customFields = JSON.parse(row.custom_fields);
                } catch (e) {
                    console.error('Error parsing custom_fields:', e);
                    customFields = {};
                }
            } else if (typeof row.custom_fields === 'object') {
                customFields = row.custom_fields;
            }
        }

        return {
            id: row.id,
            record_number: row.record_number,
            jobId: row.job_id,
            jobSeekerId: row.job_seeker_id,
            organizationId: row.organization_id,
            organizationName: row.organization_name,
            status: row.status,
            startDate: row.start_date,
            endDate: row.end_date,
            internalEmailNotification: row.internal_email_notification,
            salary: row.salary,
            placementFeePercent: row.placement_fee_percent,
            placementFeeFlat: row.placement_fee_flat,
            daysGuaranteed: row.days_guaranteed,
            hoursPerDay: row.hours_per_day,
            hoursOfOperation: row.hours_of_operation,
            payRate: row.pay_rate,
            payRateChecked: row.pay_rate_checked,
            effectiveDate: row.effective_date,
            effectiveDateChecked: row.effective_date_checked,
            overtimeExemption: row.overtime_exemption,
            createdBy: row.created_by,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            customFields: customFields,
            custom_fields: customFields, // Also include snake_case for compatibility
            // Related data
            jobTitle: row.job_title,
            jobStatus: row.job_status,
            jobSeekerName: row.full_name || `${row.first_name || ''} ${row.last_name || ''}`.trim(),
            jobSeekerEmail: row.job_seeker_email,
            jobSeekerPhone: row.job_seeker_phone,
            createdByName: row.created_by_name,
            archivedAt: row.archived_at,
            archiveReason: row.archive_reason,
        };
    }
}

module.exports = Placement;

