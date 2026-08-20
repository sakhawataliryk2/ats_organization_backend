const bcrypt = require('bcrypt');
const { allocateRecordNumber, releaseRecordNumber } = require('../services/recordNumberService');

// Keys to exclude from history (internal relationship IDs - redundant with user-facing Job/Contact/Candidate fields)
const HISTORY_EXCLUDED_CUSTOM_FIELD_PREFIXES = ['_relationship_'];

function sanitizeCustomFieldsForHistory(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const sanitized = { ...obj };
    Object.keys(sanitized).forEach(key => {
        if (HISTORY_EXCLUDED_CUSTOM_FIELD_PREFIXES.some(prefix => key.startsWith(prefix))) {
            delete sanitized[key];
        }
    });
    return sanitized;
}

function sanitizeHistoryDetailsForUpdate(before, after) {
    const b = before && typeof before === 'object' ? { ...before } : before;
    const a = after && typeof after === 'object' ? { ...after } : after;
    if (b && b.custom_fields) {
        b.custom_fields = sanitizeCustomFieldsForHistory(
            typeof b.custom_fields === 'string' ? JSON.parse(b.custom_fields || '{}') : b.custom_fields
        );
    }
    if (a && a.custom_fields) {
        a.custom_fields = sanitizeCustomFieldsForHistory(
            typeof a.custom_fields === 'string' ? JSON.parse(a.custom_fields || '{}') : a.custom_fields
        );
    }
    return { before: b, after: a };
}

class Lead {
    constructor(pool) {
        this.pool = pool;
    }

    // Initialize the leads table if it doesn't exist
    async initTable() {
        let client;
        try {
            console.log('Initializing leads table if needed...');
            client = await this.pool.connect();

            await client.query(`
                CREATE TABLE IF NOT EXISTS leads (
                    id SERIAL PRIMARY KEY,
                    first_name VARCHAR(255) NOT NULL,
                    last_name VARCHAR(255) NOT NULL,
                    status VARCHAR(50) DEFAULT 'New Lead',
                    nickname VARCHAR(255),
                    title VARCHAR(255),
                    organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
                    organization_name VARCHAR(255),
                    department VARCHAR(100),
                    reports_to VARCHAR(255),
                    owner VARCHAR(255),
                    secondary_owners VARCHAR(255),
                    email VARCHAR(255),
                    email2 VARCHAR(255),
                    phone VARCHAR(50),
                    mobile_phone VARCHAR(50),
                    direct_line VARCHAR(50),
                    company_phone VARCHAR(50),
                    linkedin_url VARCHAR(500),
                    address TEXT,
                    address2 VARCHAR(255),
                    city VARCHAR(255),
                    state VARCHAR(255),
                    zip_code VARCHAR(20),
                    date_added DATE DEFAULT CURRENT_DATE,
                    last_contact_date DATE,
                    created_by INTEGER REFERENCES users(id),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    custom_fields JSONB,
                    archived_at TIMESTAMP,
                    archive_reason VARCHAR(50),
                    record_number INTEGER
                )
            `);

            // Ensure organization_id uses ON DELETE CASCADE for existing installations
            await client.query(`
                ALTER TABLE leads
                DROP CONSTRAINT IF EXISTS leads_organization_id_fkey,
                ADD CONSTRAINT leads_organization_id_fkey
                    FOREIGN KEY (organization_id)
                    REFERENCES organizations(id)
                    ON DELETE CASCADE
            `);

            // Add new address-related columns if they don't exist (for existing tables)
            await client.query(`
                DO $$ 
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns 
                        WHERE table_name='leads' AND column_name='company_phone'
                    ) THEN
                        ALTER TABLE leads ADD COLUMN company_phone VARCHAR(50);
                    END IF;
                    
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns 
                        WHERE table_name='leads' AND column_name='address2'
                    ) THEN
                        ALTER TABLE leads ADD COLUMN address2 VARCHAR(255);
                    END IF;
                    
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns 
                        WHERE table_name='leads' AND column_name='city'
                    ) THEN
                        ALTER TABLE leads ADD COLUMN city VARCHAR(255);
                    END IF;
                    
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns 
                        WHERE table_name='leads' AND column_name='state'
                    ) THEN
                        ALTER TABLE leads ADD COLUMN state VARCHAR(255);
                    END IF;
                    
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns 
                        WHERE table_name='leads' AND column_name='zip_code'
                    ) THEN
                        ALTER TABLE leads ADD COLUMN zip_code VARCHAR(20);
                    END IF;
                END $$;
            `);

            // Add archived_at and archive_reason columns if they don't exist (for existing tables)
            await client.query(`
                ALTER TABLE leads ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP
            `);
            await client.query(`
                ALTER TABLE leads ADD COLUMN IF NOT EXISTS archive_reason VARCHAR(50)
            `);
            await client.query(`
                ALTER TABLE leads ADD COLUMN IF NOT EXISTS record_number INTEGER
            `);

            // Create a table for lead notes
            await client.query(`
                CREATE TABLE IF NOT EXISTS lead_notes (
                    id SERIAL PRIMARY KEY,
                    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
                    text TEXT NOT NULL,
                    action VARCHAR(255),
                    about_references JSONB,
                    created_by INTEGER REFERENCES users(id),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Add action and about_references columns if they don't exist (for existing tables)
            try {
                const actionColumnCheck = await client.query(`
                    SELECT column_name 
                    FROM information_schema.columns 
                    WHERE table_schema='public' AND table_name='lead_notes' AND column_name='action'
                `);
                if (actionColumnCheck.rows.length === 0) {
                    await client.query(`ALTER TABLE lead_notes ADD COLUMN action VARCHAR(255)`);
                    console.log('✅ Migration: Added action column to lead_notes');
                }
            } catch (err) {
                console.error('Error checking/adding action column:', err.message);
            }
            
            try {
                const aboutRefColumnCheck = await client.query(`
                    SELECT column_name 
                    FROM information_schema.columns 
                    WHERE table_schema='public' AND table_name='lead_notes' AND column_name='about_references'
                `);
                if (aboutRefColumnCheck.rows.length === 0) {
                    await client.query(`ALTER TABLE lead_notes ADD COLUMN about_references JSONB`);
                    console.log('✅ Migration: Added about_references column to lead_notes');
                }
            } catch (err) {
                console.error('Error checking/adding about_references column:', err.message);
            }

            // Create a table for lead history
            await client.query(`
                CREATE TABLE IF NOT EXISTS lead_history (
                    id SERIAL PRIMARY KEY,
                    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
                    action VARCHAR(50) NOT NULL,
                    details JSONB,
                    performed_by INTEGER REFERENCES users(id),
                    performed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            console.log('✅ Leads tables initialized successfully');
            return true;
        } catch (error) {
            console.error('❌ Error initializing leads tables:', error.message);
            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // Create a new lead
    async create(leadData) {
        const {
            firstName,
            lastName,
            status,
            nickname,
            title,
            organizationId,
            organizationName,
            department,
            reportsTo,
            owner,
            secondaryOwners,
            email,
            email2,
            phone,
            mobilePhone,
            directLine,
            companyPhone,
            linkedinUrl,
            address,
            address2,
            city,
            state,
            zipCode,
            dateAdded,
            userId,
            hiringManagerIds = [],
            jobSeekerIds = [],
            jobIds = [],
            placementIds = [],
            opportunityIds = []
        } = leadData;

        // Accept both custom_fields (from API) and customFields (camelCase) - same as organizations
        const customFields = leadData.custom_fields || leadData.customFields || {};

        console.log("Lead model - create function input:", JSON.stringify(leadData, null, 2));

        const client = await this.pool.connect();

        try {
            // Begin transaction
            await client.query('BEGIN');

            // Allocate business record number (display-only)
            const recordNumber = await allocateRecordNumber(client, 'lead');

            // Handle organization ID resolution
            let orgId = null;
            let orgName = organizationName;

            if (organizationId) {
                if (!isNaN(parseInt(organizationId))) {
                    orgId = parseInt(organizationId);
                    // Get organization name if not provided
                    if (!orgName) {
                        try {
                            const orgQuery = 'SELECT name FROM organizations WHERE id = $1';
                            const orgResult = await client.query(orgQuery, [orgId]);
                            if (orgResult.rows.length > 0) {
                                orgName = orgResult.rows[0].name;
                            }
                        } catch (error) {
                            console.log("Error finding organization by ID:", error.message);
                        }
                    }
                } else {
                    // Try to find organization by name
                    try {
                        const orgQuery = 'SELECT id, name FROM organizations WHERE name = $1';
                        const orgResult = await client.query(orgQuery, [organizationId]);
                        if (orgResult.rows.length > 0) {
                            orgId = orgResult.rows[0].id;
                            orgName = orgResult.rows[0].name;
                        } else {
                            // Store as text if not found
                            orgName = organizationId;
                        }
                    } catch (error) {
                        console.log("Error finding organization by name:", error.message);
                        orgName = organizationId;
                    }
                }
            }

            // Properly handle custom fields and merge relationship IDs
            let customFieldsObj = {};
            if (customFields) {
                if (typeof customFields === 'string') {
                    try {
                        customFieldsObj = JSON.parse(customFields);
                    } catch (e) {
                        console.log("Invalid JSON string in customFields, using empty object");
                        customFieldsObj = {};
                    }
                } else if (typeof customFields === 'object') {
                    customFieldsObj = { ...customFields };
                }
            }

            // Store relationship IDs in custom_fields for easy querying
            // These are also stored in Field_18, Field_20, etc., but we add structured versions
            if (hiringManagerIds && hiringManagerIds.length > 0) {
                customFieldsObj._relationship_hiring_manager_ids = hiringManagerIds;
            }
            if (jobSeekerIds && jobSeekerIds.length > 0) {
                customFieldsObj._relationship_job_seeker_ids = jobSeekerIds;
            }
            if (jobIds && jobIds.length > 0) {
                customFieldsObj._relationship_job_ids = jobIds;
            }
            if (placementIds && placementIds.length > 0) {
                customFieldsObj._relationship_placement_ids = placementIds;
            }
            if (opportunityIds && opportunityIds.length > 0) {
                customFieldsObj._relationship_opportunity_ids = opportunityIds;
            }

            const customFieldsJson = JSON.stringify(customFieldsObj);

            // Set up insert statement
            const insertLeadQuery = `
                INSERT INTO leads (
                    first_name,
                    last_name,
                    status,
                    nickname,
                    title,
                    organization_id,
                    organization_name,
                    department,
                    reports_to,
                    owner,
                    secondary_owners,
                    email,
                    email2,
                    phone,
                    mobile_phone,
                    direct_line,
                    company_phone,
                    linkedin_url,
                    address,
                    address2,
                    city,
                    state,
                    zip_code,
                    date_added,
                    created_by,
                    custom_fields,
                    record_number
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)
                RETURNING *
            `;

            const values = [
                firstName,
                lastName,
                status || 'New Lead',
                nickname,
                title,
                orgId,
                orgName,
                department,
                reportsTo,
                owner,
                secondaryOwners,
                email,
                email2,
                phone,
                mobilePhone,
                directLine,
                companyPhone,
                linkedinUrl,
                address,
                address2,
                city,
                state,
                zipCode,
                dateAdded || new Date().toISOString().split('T')[0],
                userId,
                customFieldsJson,
                recordNumber
            ];

            console.log("SQL Query:", insertLeadQuery);
            console.log("Query values:", values);

            const result = await client.query(insertLeadQuery, values);

            // Add an entry to history
            const historyQuery = `
                INSERT INTO lead_history (
                    lead_id,
                    action,
                    details,
                    performed_by
                )
                VALUES ($1, $2, $3, $4)
            `;

            const historyValues = [
                result.rows[0].id,
                'CREATE',
                JSON.stringify(leadData),
                userId
            ];

            await client.query(historyQuery, historyValues);

            // Commit transaction
            await client.query('COMMIT');

            console.log("Created lead:", result.rows[0]);
            return result.rows[0];
        } catch (error) {
            await client.query('ROLLBACK');
            console.error("Error in create lead:", error);
            throw error;
        } finally {
            client.release();
        }
    }

    // Get all leads (with optional filtering by created_by user)
    async getAll(userId = null) {
        const client = await this.pool.connect();
        try {
            let query = `
                SELECT l.*, u.name as created_by_name,
                CONCAT(l.last_name, ', ', l.first_name) as full_name,
                o.name as organization_name_from_org
                FROM leads l
                LEFT JOIN users u ON l.created_by = u.id
                LEFT JOIN organizations o ON l.organization_id = o.id
            `;

            const values = [];

            if (userId) {
                query += ` WHERE l.created_by = $1`;
                values.push(userId);
            }

            query += ` ORDER BY l.created_at DESC`;

            const result = await client.query(query, values);
            return result.rows;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Get lead by ID
    async getById(id, userId = null) {
        const client = await this.pool.connect();
        try {
            let query = `
                SELECT l.*, u.name as created_by_name,
                CONCAT(l.last_name, ', ', l.first_name) as full_name,
                o.name as organization_name_from_org
                FROM leads l
                LEFT JOIN users u ON l.created_by = u.id
                LEFT JOIN organizations o ON l.organization_id = o.id
                WHERE l.id = $1
            `;

            const values = [id];

            if (userId) {
                query += ` AND l.created_by = $2`;
                values.push(userId);
            }

            const result = await client.query(query, values);
            return result.rows[0] || null;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Update lead by ID
    async update(id, updateData, userId = null) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // First, get the lead to ensure it exists and check permissions
            const getLeadQuery = 'SELECT * FROM leads WHERE id = $1';
            const leadResult = await client.query(getLeadQuery, [id]);

            if (leadResult.rows.length === 0) {
                throw new Error('Lead not found');
            }

            const lead = leadResult.rows[0];

            if (userId !== null && lead.created_by !== userId) {
                throw new Error('You do not have permission to update this lead');
            }

            const oldState = { ...lead };

            // Build update query dynamically
            const updateFields = [];
            const queryParams = [];
            let paramCount = 1;

            const fieldMapping = {
                firstName: 'first_name',
                lastName: 'last_name',
                status: 'status',
                nickname: 'nickname',
                title: 'title',
                organizationId: 'organization_id',
                organizationName: 'organization_name',
                department: 'department',
                reportsTo: 'reports_to',
                owner: 'owner',
                secondaryOwners: 'secondary_owners',
                email: 'email',
                email2: 'email2',
                phone: 'phone',
                mobilePhone: 'mobile_phone',
                directLine: 'direct_line',
                companyPhone: 'company_phone',
                linkedinUrl: 'linkedin_url',
                address: 'address',
                address2: 'address2',
                city: 'city',
                state: 'state',
                zipCode: 'zip_code',
                dateAdded: 'date_added',
                lastContactDate: 'last_contact_date',
                customFields: 'custom_fields'
            };

            // Get existing custom fields first
            let existingCustomFields = {};
            try {
                existingCustomFields = typeof lead.custom_fields === 'string'
                    ? JSON.parse(lead.custom_fields || '{}')
                    : (lead.custom_fields || {});
            } catch (e) {
                console.error("Error parsing existing custom fields:", e);
                existingCustomFields = {};
            }

            // Extract relationship IDs from updateData (if provided)
            const hiringManagerIds = updateData.hiringManagerIds;
            const jobSeekerIds = updateData.jobSeekerIds;
            const jobIds = updateData.jobIds;
            const placementIds = updateData.placementIds;
            const opportunityIds = updateData.opportunityIds;

            // Handle organization ID conversion
            if (updateData.organizationId !== undefined) {
                let orgId = null;
                let orgName = updateData.organizationName;

                if (!isNaN(parseInt(updateData.organizationId))) {
                    orgId = parseInt(updateData.organizationId);
                    if (!orgName) {
                        try {
                            const orgQuery = 'SELECT name FROM organizations WHERE id = $1';
                            const orgResult = await client.query(orgQuery, [orgId]);
                            if (orgResult.rows.length > 0) {
                                orgName = orgResult.rows[0].name;
                            }
                        } catch (error) {
                            console.log("Error finding organization by ID:", error.message);
                        }
                    }
                } else if (typeof updateData.organizationId === 'string' && updateData.organizationId.trim() !== '') {
                    try {
                        const orgQuery = 'SELECT id, name FROM organizations WHERE name = $1';
                        const orgResult = await client.query(orgQuery, [updateData.organizationId]);
                        if (orgResult.rows.length > 0) {
                            orgId = orgResult.rows[0].id;
                            orgName = orgResult.rows[0].name;
                        } else {
                            orgName = updateData.organizationId;
                        }
                    } catch (error) {
                        console.log("Error finding organization by name:", error.message);
                        orgName = updateData.organizationId;
                    }
                }

                updateFields.push(`organization_id = $${paramCount}`);
                queryParams.push(orgId);
                paramCount++;

                updateFields.push(`organization_name = $${paramCount}`);
                queryParams.push(orgName);
                paramCount++;

                delete updateData.organizationId;
                delete updateData.organizationName;
            }

            // Handle custom fields merging
            const hasRelationshipIds = hiringManagerIds !== undefined || jobSeekerIds !== undefined ||
                jobIds !== undefined || placementIds !== undefined || opportunityIds !== undefined;

            if (updateData.customFields || updateData.custom_fields || hasRelationshipIds) {
                let newCustomFields = { ...existingCustomFields };

                // Merge custom fields from updateData
                const customFieldsToMerge = updateData.customFields || updateData.custom_fields;
                if (customFieldsToMerge) {
                    try {
                        const updateCustomFields = typeof customFieldsToMerge === 'string'
                            ? JSON.parse(customFieldsToMerge)
                            : customFieldsToMerge;
                        newCustomFields = { ...newCustomFields, ...updateCustomFields };
                    } catch (e) {
                        console.error("Error parsing custom fields:", e);
                    }
                }

                // Store relationship IDs in custom_fields for easy querying
                // Only update if explicitly provided in updateData
                if (hiringManagerIds !== undefined) {
                    if (Array.isArray(hiringManagerIds) && hiringManagerIds.length > 0) {
                        newCustomFields._relationship_hiring_manager_ids = hiringManagerIds;
                    } else {
                        delete newCustomFields._relationship_hiring_manager_ids;
                    }
                }
                if (jobSeekerIds !== undefined) {
                    if (Array.isArray(jobSeekerIds) && jobSeekerIds.length > 0) {
                        newCustomFields._relationship_job_seeker_ids = jobSeekerIds;
                    } else {
                        delete newCustomFields._relationship_job_seeker_ids;
                    }
                }
                if (jobIds !== undefined) {
                    if (Array.isArray(jobIds) && jobIds.length > 0) {
                        newCustomFields._relationship_job_ids = jobIds;
                    } else {
                        delete newCustomFields._relationship_job_ids;
                    }
                }
                if (placementIds !== undefined) {
                    if (Array.isArray(placementIds) && placementIds.length > 0) {
                        newCustomFields._relationship_placement_ids = placementIds;
                    } else {
                        delete newCustomFields._relationship_placement_ids;
                    }
                }
                if (opportunityIds !== undefined) {
                    if (Array.isArray(opportunityIds) && opportunityIds.length > 0) {
                        newCustomFields._relationship_opportunity_ids = opportunityIds;
                    } else {
                        delete newCustomFields._relationship_opportunity_ids;
                    }
                }

                updateFields.push(`custom_fields = $${paramCount}`);
                queryParams.push(JSON.stringify(newCustomFields));
                paramCount++;

                // Remove relationship IDs from updateData to avoid processing them again
                delete updateData.hiringManagerIds;
                delete updateData.jobSeekerIds;
                delete updateData.jobIds;
                delete updateData.placementIds;
                delete updateData.opportunityIds;
            }

            // Process all other fields
            for (const [key, value] of Object.entries(updateData)) {
                if (key !== 'customFields' && fieldMapping[key] && value !== undefined) {
                    updateFields.push(`${fieldMapping[key]} = $${paramCount}`);
                    queryParams.push(value);
                    paramCount++;
                }
            }

            updateFields.push(`updated_at = NOW()`);

            if (updateFields.length === 1) { // Only updated_at
                await client.query('ROLLBACK');
                return lead;
            }

            const updateQuery = `
                UPDATE leads 
                SET ${updateFields.join(', ')}
                WHERE id = $${paramCount}
                RETURNING *
            `;

            queryParams.push(id);

            const result = await client.query(updateQuery, queryParams);
            const updatedLead = result.rows[0];

            // Add history entry
            const historyQuery = `
                INSERT INTO lead_history (
                    lead_id,
                    action,
                    details,
                    performed_by
                )
                VALUES ($1, $2, $3, $4)
            `;

            const { before: sanitizedBefore, after: sanitizedAfter } = sanitizeHistoryDetailsForUpdate(oldState, updatedLead);
            const historyValues = [
                id,
                'UPDATE',
                JSON.stringify({
                    before: sanitizedBefore,
                    after: sanitizedAfter
                }),
                userId || lead.created_by
            ];

            await client.query(historyQuery, historyValues);

            await client.query('COMMIT');

            console.log("Lead updated successfully:", updatedLead);
            return updatedLead;
        } catch (error) {
            await client.query('ROLLBACK');
            console.error("Error updating lead:", error);
            throw error;
        } finally {
            client.release();
        }
    }

    // Delete lead by ID
    async delete(id, userId = null) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const getLeadQuery = 'SELECT * FROM leads WHERE id = $1';
            const leadResult = await client.query(getLeadQuery, [id]);

            if (leadResult.rows.length === 0) {
                throw new Error('Lead not found');
            }

            const lead = leadResult.rows[0];

            if (userId !== null && lead.created_by !== userId) {
                throw new Error('You do not have permission to delete this lead');
            }

            // Add an entry to history before deleting
            const historyQuery = `
                INSERT INTO lead_history (
                    lead_id,
                    action,
                    details,
                    performed_by
                )
                VALUES ($1, $2, $3, $4)
            `;

            const historyValues = [
                id,
                'DELETE',
                JSON.stringify(lead),
                userId || lead.created_by
            ];

            await client.query(historyQuery, historyValues);

            // Release record_number back to pool for reuse
            if (lead.record_number != null) {
                await releaseRecordNumber(client, 'lead', lead.record_number);
            }

            // Delete the lead
            const deleteQuery = 'DELETE FROM leads WHERE id = $1 RETURNING *';
            const result = await client.query(deleteQuery, [id]);

            await client.query('COMMIT');

            return result.rows[0];
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    // Add a note to a lead and update last contact date
    async addNoteAndUpdateContact(leadId, text, userId, action = null, aboutReferences = null) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // Handle about_references - convert to JSONB if it's an array/object
            let aboutReferencesJson = null;
            if (aboutReferences) {
                if (typeof aboutReferences === 'string') {
                    try {
                        // Try to parse if it's a JSON string
                        const parsed = JSON.parse(aboutReferences);
                        aboutReferencesJson = Array.isArray(parsed) ? parsed : [parsed];
                    } catch (e) {
                        // If parsing fails, treat as plain string
                        aboutReferencesJson = aboutReferences;
                    }
                } else if (Array.isArray(aboutReferences)) {
                    aboutReferencesJson = aboutReferences;
                } else if (typeof aboutReferences === 'object') {
                    aboutReferencesJson = [aboutReferences];
                }
            }

            // Add the note
            const noteQuery = `
                INSERT INTO lead_notes (lead_id, text, action, about_references, created_by)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING *
            `;

            const noteResult = await client.query(noteQuery, [
                leadId,
                text,
                action,
                aboutReferencesJson ? JSON.stringify(aboutReferencesJson) : null,
                userId
            ]);

            // Update last contact date
            const updateContactQuery = `
                UPDATE leads 
                SET last_contact_date = CURRENT_DATE, updated_at = NOW()
                WHERE id = $1
            `;

            await client.query(updateContactQuery, [leadId]);

            // Add history entry
            const historyQuery = `
                INSERT INTO lead_history (
                    lead_id,
                    action,
                    details,
                    performed_by
                )
                VALUES ($1, $2, $3, $4)
            `;

            const historyValues = [
                leadId,
                'ADD_NOTE',
                JSON.stringify({
                    noteId: noteResult.rows[0].id,
                    text,
                    lastContactUpdated: true
                }),
                userId
            ];

            await client.query(historyQuery, historyValues);

            await client.query('COMMIT');

            return {
                ...noteResult.rows[0],
                lastContactUpdated: true
            };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    // Legacy method for backward compatibility
    async addNote(leadId, text, userId, action = null, aboutReferences = null) {
        return this.addNoteAndUpdateContact(leadId, text, userId, action, aboutReferences);
    }

    // Get notes for a lead
    async getNotes(leadId) {
        const client = await this.pool.connect();
        try {
            const query = `
                SELECT n.*, u.name as created_by_name
                FROM lead_notes n
                LEFT JOIN users u ON n.created_by = u.id
                WHERE n.lead_id = $1
                ORDER BY n.created_at DESC
            `;

            const result = await client.query(query, [leadId]);
            
            // Parse about_references JSONB to object/array
            return result.rows.map(row => {
                if (row.about_references && typeof row.about_references === 'string') {
                    try {
                        row.about_references = JSON.parse(row.about_references);
                    } catch (e) {
                        // If parsing fails, keep as string
                    }
                }
                return row;
            });
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Get history for a lead
    async getHistory(leadId) {
        const client = await this.pool.connect();
        try {
            const query = `
                SELECT h.*, u.name as performed_by_name
                FROM lead_history h
                LEFT JOIN users u ON h.performed_by = u.id
                WHERE h.lead_id = $1
                ORDER BY h.performed_at DESC
            `;

            const result = await client.query(query, [leadId]);
            return result.rows.map(row => {
                if (row.details && row.action === 'UPDATE') {
                    try {
                        const details = typeof row.details === 'string' ? JSON.parse(row.details) : row.details;
                        if (details.before && details.after) {
                            const { before, after } = sanitizeHistoryDetailsForUpdate(details.before, details.after);
                            return { ...row, details: { ...details, before, after } };
                        }
                    } catch (e) {
                        // If parse/sanitize fails, return original
                    }
                }
                return row;
            });
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Get leads by organization
    async getByOrganization(organizationId, userId = null) {
        const client = await this.pool.connect();
        try {
            let query = `
                SELECT l.*, u.name as created_by_name,
                CONCAT(l.last_name, ', ', l.first_name) as full_name
                FROM leads l
                LEFT JOIN users u ON l.created_by = u.id
                WHERE l.organization_id = $1
            `;

            const values = [organizationId];

            if (userId) {
                query += ` AND l.created_by = $2`;
                values.push(userId);
            }

            query += ` ORDER BY l.created_at DESC`;

            const result = await client.query(query, values);
            return result.rows;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Search leads
    async search(searchQuery, userId = null) {
        const client = await this.pool.connect();
        try {
            let query = `
                SELECT l.*, u.name as created_by_name,
                CONCAT(l.last_name, ', ', l.first_name) as full_name,
                o.name as organization_name_from_org
                FROM leads l
                LEFT JOIN users u ON l.created_by = u.id
                LEFT JOIN organizations o ON l.organization_id = o.id
                WHERE (
                    l.first_name ILIKE $1 OR 
                    l.last_name ILIKE $1 OR 
                    l.email ILIKE $1 OR 
                    l.title ILIKE $1 OR 
                    l.organization_name ILIKE $1
                )
            `;

            const values = [`%${searchQuery}%`];

            if (userId) {
                query += ` AND l.created_by = $2`;
                values.push(userId);
            }

            query += ` ORDER BY l.created_at DESC`;

            const result = await client.query(query, values);
            return result.rows;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Get lead statistics
    async getStats(userId = null) {
        const client = await this.pool.connect();
        try {
            let baseQuery = `
                SELECT 
                    COUNT(*) as total_leads,
                    COUNT(CASE WHEN status = 'New Lead' THEN 1 END) as new_leads,
                    COUNT(CASE WHEN status = 'Qualified' THEN 1 END) as qualified_leads,
                    COUNT(CASE WHEN status = 'Contacted' THEN 1 END) as contacted_leads,
                    COUNT(CASE WHEN status = 'Converted' THEN 1 END) as converted_leads,
                    COUNT(CASE WHEN last_contact_date >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as recent_contacts
                FROM leads
            `;

            const values = [];

            if (userId) {
                baseQuery += ` WHERE created_by = $1`;
                values.push(userId);
            }

            const result = await client.query(baseQuery, values);
            return result.rows[0];
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }
}

module.exports = Lead;