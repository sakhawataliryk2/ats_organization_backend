// This is the updated Job model - models/job.js 
const bcrypt = require('bcrypt');
const { allocateRecordNumber, releaseRecordNumber, runMigrationIfNeeded } = require('../services/recordNumberService');

class Job {
    constructor(pool) {
        this.pool = pool;
    }

    // Initialize the jobs table if it doesn't exist
    async initTable() {
        let client;
        try {
            console.log('Initializing jobs table if needed...');
            client = await this.pool.connect();

            await client.query(`
                CREATE TABLE IF NOT EXISTS jobs (
                id SERIAL PRIMARY KEY,
                job_title VARCHAR(255),
                job_type VARCHAR(50),
                category VARCHAR(100),
                organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
                hiring_manager VARCHAR(255),
                status VARCHAR(50) DEFAULT 'Open',
                priority VARCHAR(10),
                employment_type VARCHAR(50),
                start_date DATE,
                worksite_location TEXT,
                remote_option VARCHAR(50),
                job_description TEXT,
                salary_type VARCHAR(20) DEFAULT 'yearly',
                min_salary NUMERIC,
                max_salary NUMERIC,
                benefits TEXT,
                required_skills TEXT,
                job_board_status VARCHAR(50) DEFAULT 'Not Posted',
                owner VARCHAR(255),
                date_added DATE,
                created_by INTEGER REFERENCES users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                custom_fields JSONB,
                archived_at TIMESTAMP,
                archive_reason VARCHAR(50)
                )
            `);

            // Ensure organization_id uses ON DELETE CASCADE for existing installations
            await client.query(`
                ALTER TABLE jobs
                DROP CONSTRAINT IF EXISTS jobs_organization_id_fkey,
                ADD CONSTRAINT jobs_organization_id_fkey
                    FOREIGN KEY (organization_id)
                    REFERENCES organizations(id)
                    ON DELETE CASCADE
            `);

            // Also create a table for job notes if it doesn't exist
            await client.query(`
                CREATE TABLE IF NOT EXISTS job_notes (
                id SERIAL PRIMARY KEY,
                job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
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
                    WHERE table_schema='public' AND table_name='job_notes' AND column_name='action'
                `);
                if (actionColumnCheck.rows.length === 0) {
                    await client.query(`ALTER TABLE job_notes ADD COLUMN action VARCHAR(255)`);
                    console.log('✅ Migration: Added action column to job_notes');
                }
            } catch (err) {
                console.error('Error checking/adding action column:', err.message);
            }
            
            try {
                const aboutRefColumnCheck = await client.query(`
                    SELECT column_name 
                    FROM information_schema.columns 
                    WHERE table_schema='public' AND table_name='job_notes' AND column_name='about_references'
                `);
                if (aboutRefColumnCheck.rows.length === 0) {
                    await client.query(`ALTER TABLE job_notes ADD COLUMN about_references JSONB`);
                    console.log('✅ Migration: Added about_references column to job_notes');
                }
            } catch (err) {
                console.error('Error checking/adding about_references column:', err.message);
            }

            // Create a table for job history
            await client.query(`
                CREATE TABLE IF NOT EXISTS job_history (
                id SERIAL PRIMARY KEY,
                job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                action VARCHAR(50) NOT NULL,
                details JSONB,
                performed_by INTEGER REFERENCES users(id),
                performed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Add archived_at and archive_reason columns if they don't exist (for existing tables)
            await client.query(`
                ALTER TABLE jobs ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP
            `);
            await client.query(`
                ALTER TABLE jobs ADD COLUMN IF NOT EXISTS archive_reason VARCHAR(50)
            `);
            await client.query(`
                ALTER TABLE jobs ADD COLUMN IF NOT EXISTS record_number INTEGER
            `);

            await runMigrationIfNeeded(client);

            console.log('✅ Jobs tables initialized successfully');
            return true;
        } catch (error) {
            console.error('❌ Error initializing jobs tables:', error.message);
            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // Create a new job
    async create(jobData) {
        const {
            jobTitle,
            jobType,
            category,
            organizationId,
            hiringManager,
            status,
            priority,
            employmentType,
            startDate,
            worksiteLocation,
            remoteOption,
            jobDescription,
            salaryType,
            minSalary,
            maxSalary,
            benefits,
            requiredSkills,
            jobBoardStatus,
            owner,
            dateAdded,
            userId,
            custom_fields = {}   // ✅ Use snake_case like Organizations
        } = jobData;

        console.log("Job model - create function input:", JSON.stringify(jobData, null, 2));
        console.log("Custom fields received in model:", custom_fields);
        console.log("Custom fields type in model:", typeof custom_fields);

        const client = await this.pool.connect();

        try {
            // Begin transaction
            await client.query('BEGIN');

            // Handle organization ID resolution
            let orgId = null;
            if (organizationId) {
                if (!isNaN(parseInt(organizationId))) {
                    orgId = parseInt(organizationId);
                } else {
                    try {
                        const orgQuery = 'SELECT id FROM organizations WHERE name = $1';
                        const orgResult = await client.query(orgQuery, [organizationId]);
                        if (orgResult.rows.length > 0) {
                            orgId = orgResult.rows[0].id;
                        }
                    } catch (error) {
                        console.log("Error finding organization by name:", error.message);
                    }
                }
            }

            // ✅ Convert custom fields for PostgreSQL JSONB (same pattern as Organizations)
            let customFieldsJson = '{}';

            if (custom_fields) {
                if (typeof custom_fields === 'string') {
                    // It's already a string, validate it's valid JSON
                    try {
                        JSON.parse(custom_fields);
                        customFieldsJson = custom_fields;
                    } catch (e) {
                        console.error("Invalid JSON string in custom_fields:", e);
                        customFieldsJson = '{}';
                    }
                } else if (typeof custom_fields === 'object' && !Array.isArray(custom_fields) && custom_fields !== null) {
                    // It's a valid object, stringify it
                    try {
                        customFieldsJson = JSON.stringify(custom_fields);
                    } catch (e) {
                        console.error("Error stringifying custom_fields:", e);
                        customFieldsJson = '{}';
                    }
                }
            }

            // Debug log
            console.log("Custom fields processing:");
            console.log("  - Received custom_fields:", custom_fields);
            console.log("  - Type:", typeof custom_fields);
            console.log("  - Is array:", Array.isArray(custom_fields));
            console.log("  - Final JSON string:", customFieldsJson);
            console.log("  - Final JSON string length:", customFieldsJson.length);
            console.log("  - Parsed keys count:", customFieldsJson !== '{}' ? Object.keys(JSON.parse(customFieldsJson)).length : 0);

            const recordNumber = await allocateRecordNumber(client, 'job');

            // Set up insert statement with column names matching the database
            const insertJobQuery = `
            INSERT INTO jobs (
            record_number,
            job_title,
            job_type,
            category,
            organization_id,
            hiring_manager,
            status,
            priority,
            employment_type,
            start_date,
            worksite_location,
            remote_option,
            job_description,
            salary_type,
            min_salary,
            max_salary,
            benefits,
            required_skills,
            job_board_status,
            owner,
            date_added,
            created_by,
            custom_fields
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
            RETURNING *
        `;

            // Prepare values in the same order as the columns in the query
            const values = [
                recordNumber,
                jobTitle,
                jobType,
                category,
                orgId,
                hiringManager,
                status || 'Open',
                priority,
                employmentType,
                startDate || null,
                worksiteLocation,
                remoteOption,
                jobDescription,
                salaryType || 'yearly',
                minSalary ? parseFloat(minSalary) : null,
                maxSalary ? parseFloat(maxSalary) : null,
                benefits,
                requiredSkills,
                jobBoardStatus || 'Not Posted',
                owner,
                dateAdded || new Date().toISOString().split('T')[0],
                userId,
                customFieldsJson  // Use our properly formatted JSON string
            ];

            // Debug log the SQL and values
            console.log("SQL Query:", insertJobQuery);
            console.log("Query values:", values);

            const result = await client.query(insertJobQuery, values);

            // Add an entry to history
            const historyQuery = `
            INSERT INTO job_history (
            job_id,
            action,
            details,
            performed_by
            )
            VALUES ($1, $2, $3, $4)
        `;

            const historyValues = [
                result.rows[0].id,
                'CREATE',
                JSON.stringify(jobData),
                userId
            ];

            await client.query(historyQuery, historyValues);

            // Commit transaction
            await client.query('COMMIT');

            console.log("Created job:", result.rows[0]);
            return result.rows[0];
        } catch (error) {
            // Rollback transaction in case of error
            await client.query('ROLLBACK');
            console.error("Error in create job:", error);
            throw error;
        } finally {
            client.release();
        }
    }

    // Get all jobs (with optional filtering by created_by user)
    async getAll(userId = null) {
        const client = await this.pool.connect();
        try {
            let query = `
                SELECT j.*, u.name as created_by_name,
                o.name as organization_name
                FROM jobs j
                LEFT JOIN users u ON j.created_by = u.id
                LEFT JOIN organizations o ON j.organization_id = o.id
            `;

            const values = [];

            // If userId is provided, filter jobs by the user that created them
            if (userId) {
                query += ` WHERE j.created_by = $1`;
                values.push(userId);
            }

            query += ` ORDER BY j.created_at DESC`;

            const result = await client.query(query, values);
            return result.rows;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Get job by ID, optionally checking created_by user
    async getById(id, userId = null) {
        const client = await this.pool.connect();
        try {
            let query = `
                SELECT j.*, u.name as created_by_name,
                o.name as organization_name
                FROM jobs j
                LEFT JOIN users u ON j.created_by = u.id
                LEFT JOIN organizations o ON j.organization_id = o.id
                WHERE j.id = $1
            `;

            const values = [id];

            // If userId is provided, ensure the job was created by this user
            if (userId) {
                query += ` AND j.created_by = $2`;
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

    // Get multiple jobs by IDs (for XML export)
    async getByIds(ids, userId = null) {
        const client = await this.pool.connect();
        try {
            let query = `
                SELECT j.*, u.name as created_by_name,
                o.name as organization_name
                FROM jobs j
                LEFT JOIN users u ON j.created_by = u.id
                LEFT JOIN organizations o ON j.organization_id = o.id
                WHERE j.id = ANY($1)
            `;

            const values = [ids];

            // If userId is provided, filter by user
            if (userId) {
                query += ` AND j.created_by = $2`;
                values.push(userId);
            }

            query += ` ORDER BY j.id DESC`;

            const result = await client.query(query, values);
            return result.rows;
        } catch (error) {
            console.error('Error getting jobs by IDs:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    async getAdditionalSkillSuggestions(searchQuery, limit = 20) {
        const q = String(searchQuery || '').trim();
        const lim = Number.isFinite(Number(limit))
            ? Math.max(1, Math.min(50, Number(limit)))
            : 20;

        const client = await this.pool.connect();
        try {
            const query = `
                SELECT DISTINCT TRIM(s.skill) AS skill
                FROM (
                    SELECT unnest(regexp_split_to_array(kv.value, ',')) AS skill
                    FROM jobs j,
                         jsonb_each_text(COALESCE(j.custom_fields, '{}'::jsonb)) AS kv(key, value)
                    WHERE LOWER(kv.key) LIKE '%additional%'
                      AND LOWER(kv.key) LIKE '%skill%'
                ) s
                WHERE TRIM(s.skill) <> ''
                  AND ($1::text = '' OR LOWER(TRIM(s.skill)) LIKE '%' || LOWER($1::text) || '%')
                ORDER BY skill
                LIMIT $2
            `;

            const result = await client.query(query, [q, lim]);
            return (result.rows || []).map((r) => r.skill).filter(Boolean);
        } catch (error) {
            console.error('Error getting additional skill suggestions:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    // IMPORTANT: Fixed update method with improved field mapping
    async update(id, updateData, userId = null) {
        const client = await this.pool.connect();
        try {
            // Begin transaction
            await client.query('BEGIN');

            // First, get the job to ensure it exists and check permissions
            const getJobQuery = 'SELECT * FROM jobs WHERE id = $1';
            const jobResult = await client.query(getJobQuery, [id]);

            if (jobResult.rows.length === 0) {
                throw new Error('Job not found');
            }

            const job = jobResult.rows[0];

            // If userId is provided (not admin/owner), check permission
            if (userId !== null && job.created_by !== userId) {
                throw new Error('You do not have permission to update this job');
            }

            // Store the old state for audit
            const oldState = { ...job };

            // Build update query dynamically based on provided fields
            const updateFields = [];
            const queryParams = [];
            let paramCount = 1;

            // Handle all possible fields to update - Map camelCase keys to snake_case database columns
            const fieldMapping = {
                jobTitle: 'job_title',
                category: 'category',
                organizationId: 'organization_id',
                hiringManager: 'hiring_manager',
                status: 'status',
                priority: 'priority',
                employmentType: 'employment_type',
                startDate: 'start_date',
                worksiteLocation: 'worksite_location',
                remoteOption: 'remote_option',
                jobDescription: 'job_description',
                salaryType: 'salary_type',
                minSalary: 'min_salary',
                maxSalary: 'max_salary',
                benefits: 'benefits',
                requiredSkills: 'required_skills',
                jobBoardStatus: 'job_board_status',
                owner: 'owner',
                dateAdded: 'date_added',
                customFields: 'custom_fields'
            };

            // Log the incoming update data for debugging
            console.log("Update data received:", updateData);

            // ✅ Handle custom fields merging (same pattern as Organizations)
            if (updateData.customFields || updateData.custom_fields) {
                const customFieldsData = updateData.customFields || updateData.custom_fields;
                let newCustomFields = {};

                try {
                    const existingCustomFields = typeof job.custom_fields === 'string'
                        ? JSON.parse(job.custom_fields || '{}')
                        : (job.custom_fields || {});

                    const updateCustomFields = typeof customFieldsData === 'string'
                        ? JSON.parse(customFieldsData)
                        : customFieldsData;

                    // Ensure updateCustomFields is an object, not an integer or other type
                    if (typeof updateCustomFields === 'object' && updateCustomFields !== null && !Array.isArray(updateCustomFields)) {
                        newCustomFields = { ...existingCustomFields, ...updateCustomFields };
                    } else {
                        console.error("Warning: custom_fields data is not a valid object:", updateCustomFields);
                        newCustomFields = existingCustomFields; // Keep existing if new data is invalid
                    }
                } catch (e) {
                    console.error("Error parsing custom fields:", e);
                    // If parsing fails, ensure we still have a valid object
                    if (typeof customFieldsData === 'object' && customFieldsData !== null && !Array.isArray(customFieldsData)) {
                        newCustomFields = customFieldsData;
                    } else {
                        newCustomFields = {};
                    }
                }

                // Final validation: ensure newCustomFields is always an object
                if (typeof newCustomFields !== 'object' || newCustomFields === null || Array.isArray(newCustomFields)) {
                    console.error("CRITICAL: newCustomFields is not a valid object, using empty object");
                    newCustomFields = {};
                }

                updateFields.push(`custom_fields = $${paramCount}`);
                queryParams.push(newCustomFields); // DB JSONB me directly save ho jayega
                paramCount++;

                // Remove from further processing
                delete updateData.customFields;
                delete updateData.custom_fields;
            }

            // Handle organization ID conversion
            if (updateData.organizationId !== undefined) {
                let orgId = null;

                if (!isNaN(parseInt(updateData.organizationId))) {
                    orgId = parseInt(updateData.organizationId);
                } else if (typeof updateData.organizationId === 'string' && updateData.organizationId.trim() !== '') {
                    try {
                        const orgQuery = 'SELECT id FROM organizations WHERE name = $1';
                        const orgResult = await client.query(orgQuery, [updateData.organizationId]);
                        if (orgResult.rows.length > 0) {
                            orgId = orgResult.rows[0].id;
                        }
                    } catch (error) {
                        console.log("Error finding organization by name:", error.message);
                    }
                }

                updateFields.push(`organization_id = $${paramCount}`);
                queryParams.push(orgId);
                paramCount++;

                // Remove from normal processing
                delete updateData.organizationId;
            }

            // Process all other fields - Map from camelCase to snake_case (only known keys to avoid DB errors)
            for (const [key, value] of Object.entries(updateData)) {
                // Skip customFields and custom_fields as they're already processed
                if (key === 'customFields' || key === 'custom_fields') {
                    continue;
                }

                // Skip undefined values - don't include them in the update
                if (value === undefined) {
                    continue;
                }

                // Only update columns we know about; ignore unknown keys from frontend
                if (!(key in fieldMapping)) {
                    console.warn(`Skipping unknown field "${key}" in job update`);
                    continue;
                }

                // Get the database field name (snake_case)
                const dbFieldName = fieldMapping[key];
                let paramValue = value;

                // Handle numeric conversions
                if (key === 'minSalary' || key === 'maxSalary') {
                    paramValue = value ? parseFloat(value) : null;
                }

                // Handle date fields: empty string is invalid for PostgreSQL DATE, use null
                if (key === 'startDate' || key === 'dateAdded') {
                    const trimmed = typeof value === 'string' ? value.trim() : value;
                    paramValue = (trimmed === '' || trimmed === null || trimmed === undefined) ? null : trimmed;
                }

                // Ensure paramValue is not undefined before adding
                if (paramValue === undefined) {
                    console.warn(`Warning: paramValue is undefined for field ${key} (${dbFieldName}), skipping`);
                    continue;
                }

                // Add field and parameter
                console.log(`Adding field: ${dbFieldName} = $${paramCount}, value:`, paramValue, `type:`, typeof paramValue);
                updateFields.push(`${dbFieldName} = $${paramCount}`);
                queryParams.push(paramValue);
                paramCount++;
            }

            // Always update the updated_at timestamp
            updateFields.push(`updated_at = NOW()`);

            // If no fields to update, just return the existing job
            if (updateFields.length === 0) {
                await client.query('ROLLBACK');
                return job; // No fields to update
            }

            // Construct the full update query
            const updateQuery = `
                UPDATE jobs 
                SET ${updateFields.join(', ')}
                WHERE id = $${paramCount}
                RETURNING *
            `;

            queryParams.push(id);

            // Log the update query and parameters
            console.log("Update query:", updateQuery);
            console.log("Update params:", queryParams);

            const result = await client.query(updateQuery, queryParams);
            const updatedJob = result.rows[0];

            // Add history entry
            const historyQuery = `
                INSERT INTO job_history (
                    job_id,
                    action,
                    details,
                    performed_by
                )
                VALUES ($1, $2, $3, $4)
            `;

            const historyValues = [
                id,
                'UPDATE',
                JSON.stringify({
                    before: oldState,
                    after: updatedJob
                }),
                userId || job.created_by
            ];

            await client.query(historyQuery, historyValues);

            // Commit transaction
            await client.query('COMMIT');

            console.log("Job updated successfully:", updatedJob);
            return updatedJob;
        } catch (error) {
            // Rollback transaction in case of error
            await client.query('ROLLBACK');
            console.error("Error updating job:", error);
            throw error;
        } finally {
            client.release();
        }
    }

    // Delete job by ID
    async delete(id, userId = null) {
        const client = await this.pool.connect();
        try {
            // Begin transaction
            await client.query('BEGIN');

            // First, get the job to ensure it exists and for audit
            const getJobQuery = 'SELECT * FROM jobs WHERE id = $1';
            const jobResult = await client.query(getJobQuery, [id]);

            if (jobResult.rows.length === 0) {
                throw new Error('Job not found');
            }

            const job = jobResult.rows[0];

            // If userId is provided (not admin/owner), check permission
            if (userId !== null && job.created_by !== userId) {
                throw new Error('You do not have permission to delete this job');
            }

            // Add an entry to history before deleting
            const historyQuery = `
                INSERT INTO job_history (
                    job_id,
                    action,
                    details,
                    performed_by
                )
                VALUES ($1, $2, $3, $4)
            `;

            const historyValues = [
                id,
                'DELETE',
                JSON.stringify(job),
                userId || job.created_by // Use original creator if no specific user
            ];

            await client.query(historyQuery, historyValues);

            if (job.record_number != null) {
                await releaseRecordNumber(client, 'job', job.record_number);
            }

            // Delete the job
            const deleteQuery = 'DELETE FROM jobs WHERE id = $1 RETURNING *';
            const result = await client.query(deleteQuery, [id]);

            // Commit transaction
            await client.query('COMMIT');

            return result.rows[0];
        } catch (error) {
            // Rollback transaction in case of error
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    // Add a note to a job
    async addNote(jobId, text, userId, action = null, aboutReferences = null) {
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

            // Insert the note
            const noteQuery = `
                INSERT INTO job_notes (job_id, text, action, about_references, created_by)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING *
            `;

            const noteResult = await client.query(noteQuery, [
                jobId,
                text,
                action,
                aboutReferencesJson ? JSON.stringify(aboutReferencesJson) : null,
                userId
            ]);

            // Add history entry for the note
            const historyQuery = `
                INSERT INTO job_history (
                    job_id,
                    action,
                    details,
                    performed_by
                )
                VALUES ($1, $2, $3, $4)
            `;

            const historyValues = [
                jobId,
                'ADD_NOTE',
                JSON.stringify({ noteId: noteResult.rows[0].id, text }),
                userId
            ];

            await client.query(historyQuery, historyValues);

            await client.query('COMMIT');

            return noteResult.rows[0];
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    // Get notes for a job
    async getNotes(jobId) {
        const client = await this.pool.connect();
        try {
            const query = `
                SELECT n.*, u.name as created_by_name
                FROM job_notes n
                LEFT JOIN users u ON n.created_by = u.id
                WHERE n.job_id = $1
                ORDER BY n.created_at DESC
            `;

            const result = await client.query(query, [jobId]);
            
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

    // Get history for a job
    async getHistory(jobId) {
        const client = await this.pool.connect();
        try {
            const query = `
                SELECT h.*, u.name as performed_by_name
                FROM job_history h
                LEFT JOIN users u ON h.performed_by = u.id
                WHERE h.job_id = $1
                ORDER BY h.performed_at DESC
            `;

            const result = await client.query(query, [jobId]);
            return result.rows;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }
}

module.exports = Job;