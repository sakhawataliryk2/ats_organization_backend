const bcrypt = require('bcrypt');
const { allocateRecordNumber, releaseRecordNumber, runMigrationIfNeeded } = require('../services/recordNumberService');

let jobSeekerTablesInitialized = false;

class JobSeeker {
    constructor(pool) {
        this.pool = pool;
    }

    // Initialize the job seekers table if it doesn't exist
    async initTable() {
        if (jobSeekerTablesInitialized) return;
        let client;
        try {
            console.log('Initializing job seekers table if needed...');
            client = await this.pool.connect();

            // Ensure reusable record-number system exists (idempotent)
            await runMigrationIfNeeded(client);

            await client.query(`
                CREATE TABLE IF NOT EXISTS job_seekers (
                    id SERIAL PRIMARY KEY,
                    first_name VARCHAR(255) NOT NULL,
                    last_name VARCHAR(255) NOT NULL,
                    email VARCHAR(255),
                    phone VARCHAR(50),
                    mobile_phone VARCHAR(50),
                    address TEXT,
                    city VARCHAR(100),
                    state VARCHAR(50),
                    zip VARCHAR(20),
                    status VARCHAR(50) DEFAULT 'New lead',
                    current_organization VARCHAR(255),
                    title VARCHAR(255),
                    resume_text TEXT,
                    skills TEXT,
                    desired_salary VARCHAR(50),
                    owner VARCHAR(255),
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
            await client.query(`
                ALTER TABLE job_seekers ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP
            `);
            await client.query(`
                ALTER TABLE job_seekers ADD COLUMN IF NOT EXISTS archive_reason VARCHAR(50)
            `);
            await client.query(`
                ALTER TABLE job_seekers ADD COLUMN IF NOT EXISTS record_number INTEGER
            `);

            // Backfill record_number for existing rows that predate allocation
            await client.query(`
                WITH ordered AS (
                    SELECT
                        id,
                        ROW_NUMBER() OVER (ORDER BY id)
                        + COALESCE((SELECT MAX(record_number) FROM job_seekers WHERE record_number IS NOT NULL), 0) AS rn
                    FROM job_seekers
                    WHERE record_number IS NULL
                )
                UPDATE job_seekers js
                SET record_number = ordered.rn
                FROM ordered
                WHERE js.id = ordered.id
            `);

            // Enforce uniqueness + non-null going forward
            await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_job_seekers_record_number ON job_seekers (record_number)`);
            await client.query(`ALTER TABLE job_seekers ALTER COLUMN record_number SET NOT NULL`);

            // Enforce unique, case-insensitive email for job seekers (ignores NULLs)
            try {
                await client.query(`
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_job_seekers_email_lower_unique
                    ON job_seekers (LOWER(email))
                    WHERE email IS NOT NULL
                `);
                console.log('✅ Unique index ensured on job_seekers.email (case-insensitive, non-null)');
            } catch (err) {
                console.error('⚠️  Warning: failed to ensure unique index on job_seekers.email:', err.message);
            }

            // Ensure sequence continues from current max
            await client.query(`SELECT setval('job_seeker_record_number_seq', (SELECT COALESCE(MAX(record_number), 0) FROM job_seekers))`);

            // Also create a table for job seeker notes if it doesn't exist
            await client.query(`
                CREATE TABLE IF NOT EXISTS job_seeker_notes (
                    id SERIAL PRIMARY KEY,
                    job_seeker_id INTEGER NOT NULL REFERENCES job_seekers(id) ON DELETE CASCADE,
                    text TEXT NOT NULL,
                    note_type VARCHAR(255) DEFAULT 'General Note',
                    action VARCHAR(255),
                    about_references JSONB,
                    created_by INTEGER REFERENCES users(id),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            // Add note_type column for existing tables that were created before it was added
            await client.query(`
                ALTER TABLE job_seeker_notes ADD COLUMN IF NOT EXISTS note_type VARCHAR(255) DEFAULT 'General Note'
            `);
            // Add action and about_references columns if they don't exist (for existing tables)
            try {
                const actionColumnCheck = await client.query(`
                    SELECT column_name 
                    FROM information_schema.columns 
                    WHERE table_schema='public' AND table_name='job_seeker_notes' AND column_name='action'
                `);
                if (actionColumnCheck.rows.length === 0) {
                    await client.query(`ALTER TABLE job_seeker_notes ADD COLUMN action VARCHAR(255)`);
                    console.log('✅ Migration: Added action column to job_seeker_notes');
                }
            } catch (err) {
                console.error('Error checking/adding action column:', err.message);
            }
            
            try {
                const aboutRefColumnCheck = await client.query(`
                    SELECT column_name 
                    FROM information_schema.columns 
                    WHERE table_schema='public' AND table_name='job_seeker_notes' AND column_name='about_references'
                `);
                if (aboutRefColumnCheck.rows.length === 0) {
                    await client.query(`ALTER TABLE job_seeker_notes ADD COLUMN about_references JSONB`);
                    console.log('✅ Migration: Added about_references column to job_seeker_notes');
                }
            } catch (err) {
                console.error('Error checking/adding about_references column:', err.message);
            }

            // Create a table for job seeker history
            await client.query(`
                CREATE TABLE IF NOT EXISTS job_seeker_history (
                    id SERIAL PRIMARY KEY,
                    job_seeker_id INTEGER NOT NULL REFERENCES job_seekers(id) ON DELETE CASCADE,
                    action VARCHAR(50) NOT NULL,
                    details JSONB,
                    performed_by INTEGER REFERENCES users(id),
                    performed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            console.log('✅ Job seekers tables initialized successfully');
            jobSeekerTablesInitialized = true;
            return true;
        } catch (error) {
            console.error('❌ Error initializing job seekers tables:', error.message);
            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // Create a new job seeker
    async create(jobSeekerData) {
        const {
            firstName,
            lastName,
            email,
            phone,
            mobilePhone,
            address,
            city,
            state,
            zip,
            status,
            currentOrganization,
            title,
            resumeText,
            skills,
            desiredSalary,
            owner,
            dateAdded,
            lastContactDate,
            userId,
             custom_fields = {}   // ✅ Use snake_case like Organizations
        } = jobSeekerData;

        console.log("JobSeeker model - create function input:", JSON.stringify(jobSeekerData, null, 2));

        const client = await this.pool.connect();

        try {
            // Begin transaction
            await client.query('BEGIN');

            // Allocate business record number (display-only)
            const recordNumber = await allocateRecordNumber(client, 'job_seeker');

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

            // Set up insert statement with column names matching the database
            const insertJobSeekerQuery = `
                INSERT INTO job_seekers (
                    first_name,
                    last_name,
                    email,
                    phone,
                    mobile_phone,
                    address,
                    city,
                    state,
                    zip,
                    status,
                    current_organization,
                    title,
                    resume_text,
                    skills,
                    desired_salary,
                    owner,
                    date_added,
                    last_contact_date,
                    created_by,
                    custom_fields,
                    record_number
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
                RETURNING *
            `;

            // Prepare values in the same order as the columns in the query
            const values = [
                firstName,
                lastName,
                email,
                phone,
                mobilePhone || phone, // If no mobile phone, use primary phone
                address,
                city,
                state,
                zip,
                status || 'New lead',
                currentOrganization,
                title,
                resumeText,
                skills,
                desiredSalary,
                owner,
                dateAdded || new Date().toISOString().split('T')[0],
                lastContactDate || null,
                userId,
                customFieldsJson,  // Pass JSON string - consistent with Organizations
                recordNumber
            ];

            // Debug log the SQL and values
            console.log("SQL Query:", insertJobSeekerQuery);
            console.log("Query values:", values);

            const result = await client.query(insertJobSeekerQuery, values);

            // Add an entry to history
            const historyQuery = `
                INSERT INTO job_seeker_history (
                    job_seeker_id,
                    action,
                    details,
                    performed_by
                )
                VALUES ($1, $2, $3, $4)
            `;

            const historyValues = [
                result.rows[0].id,
                'CREATE',
                JSON.stringify(jobSeekerData),
                userId
            ];

            await client.query(historyQuery, historyValues);

            // Commit transaction
            await client.query('COMMIT');

            console.log("Created job seeker:", result.rows[0]);
            return result.rows[0];
        } catch (error) {
            // Rollback transaction in case of error
            await client.query('ROLLBACK');
            console.error("Error in create job seeker:", error);
            throw error;
        } finally {
            client.release();
        }
    }

    // Get all job seekers (with optional filtering by created_by user and archived state)
    // archivedFilter: true = only archived, false = exclude archived, null/undefined = return all (like jobs)
    async getAll(userId = null, archivedFilter = null) {
        const client = await this.pool.connect();
        try {
            let query = `
                SELECT js.*, u.name as created_by_name,
                CONCAT(js.last_name, ', ', js.first_name) as full_name,
                js.date_added::text, js.last_contact_date::text
                FROM job_seekers js
                LEFT JOIN users u ON js.created_by = u.id
            `;

            const conditions = [];
            const values = [];
            let paramCount = 1;

            if (userId) {
                conditions.push(`js.created_by = $${paramCount}`);
                values.push(userId);
                paramCount++;
            }

            if (archivedFilter === true) {
                conditions.push(`(js.status = 'Archived' OR js.archived_at IS NOT NULL)`);
            } else if (archivedFilter === false) {
                conditions.push(`(js.status IS NULL OR js.status != 'Archived')`);
                conditions.push(`js.archived_at IS NULL`);
            }

            if (conditions.length > 0) {
                query += ` WHERE ` + conditions.join(" AND ");
            }

            query += ` ORDER BY js.created_at DESC`;

            const result = await client.query(query, values);
            return result.rows;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Get job seeker by ID, optionally checking created_by user
    async getById(id, userId = null) {
        const client = await this.pool.connect();
        try {
            let query = `
                SELECT js.*, u.name as created_by_name,
                CONCAT(js.last_name, ', ', js.first_name) as full_name,
                js.date_added::text, js.last_contact_date::text
                FROM job_seekers js
                LEFT JOIN users u ON js.created_by = u.id
                WHERE js.id = $1
            `;

            const values = [id];

            // If userId is provided, ensure the job seeker was created by this user
            if (userId) {
                query += ` AND js.created_by = $2`;
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

    // Update job seeker by ID
    async update(id, updateData, userId = null) {
        const client = await this.pool.connect();
        try {
            // Begin transaction
            await client.query('BEGIN');

            // First, get the job seeker to ensure it exists and check permissions
            const getJobSeekerQuery = 'SELECT * FROM job_seekers WHERE id = $1';
            const jobSeekerResult = await client.query(getJobSeekerQuery, [id]);

            if (jobSeekerResult.rows.length === 0) {
                throw new Error('Job seeker not found');
            }

            const jobSeeker = jobSeekerResult.rows[0];

            // If userId is provided (not admin/owner), check permission
            if (userId !== null && jobSeeker.created_by !== userId) {
                throw new Error('You do not have permission to update this job seeker');
            }

            // Store the old state for audit
            const oldState = { ...jobSeeker };

            // Build update query dynamically based on provided fields
            const updateFields = [];
            const queryParams = [];
            let paramCount = 1;

            // Handle all possible fields to update - Map camelCase keys to snake_case database columns
            const fieldMapping = {
                firstName: 'first_name',
                lastName: 'last_name',
                email: 'email',
                phone: 'phone',
                mobilePhone: 'mobile_phone',
                address: 'address',
                city: 'city',
                state: 'state',
                zip: 'zip',
                status: 'status',
                currentOrganization: 'current_organization',
                title: 'title',
                resumeText: 'resume_text',
                skills: 'skills',
                desiredSalary: 'desired_salary',
                owner: 'owner',
                dateAdded: 'date_added',
                lastContactDate: 'last_contact_date',
                custom_fields: 'custom_fields'
            };

            // Log the incoming update data for debugging
            console.log("Update data received:", updateData);

            // ✅ Handle custom fields merging (same pattern as Organizations)
            if (updateData.customFields || updateData.custom_fields) {
                const customFieldsData = updateData.customFields || updateData.custom_fields;
                let newCustomFields = {};

                try {
                    const existingCustomFields = typeof jobSeeker.custom_fields === 'string'
                        ? JSON.parse(jobSeeker.custom_fields || '{}')
                        : (jobSeeker.custom_fields || {});

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

            // Process all other fields - Map from camelCase to snake_case
            for (const [key, value] of Object.entries(updateData)) {
                // Skip customFields and custom_fields as they're already processed
                if (key === 'customFields' || key === 'custom_fields') {
                    continue;
                }

                // Skip undefined values - don't include them in the update
                if (value === undefined) {
                    continue;
                }

                // Get the database field name (snake_case)
                const dbFieldName = fieldMapping[key] || key;
                
                // Ensure paramValue is not undefined before adding
                if (value === undefined) {
                    console.warn(`Warning: paramValue is undefined for field ${key} (${dbFieldName}), skipping`);
                    continue;
                }

                // Add field and parameter
                console.log(`Adding field: ${dbFieldName} = $${paramCount}, value:`, value, `type:`, typeof value);
                updateFields.push(`${dbFieldName} = $${paramCount}`);
                queryParams.push(value);
                paramCount++;
            }

            // Always update the updated_at timestamp
            updateFields.push(`updated_at = NOW()`);

            // If no fields to update, just return the existing job
            if (updateFields.length === 0) {
                await client.query('ROLLBACK');
                return jobSeeker; // No fields to update
            }

            // Construct the full update query
            const updateQuery = `
                UPDATE job_seekers 
                SET ${updateFields.join(', ')}
                WHERE id = $${paramCount}
                RETURNING *
            `;

            queryParams.push(id);

            // Log the update query and parameters
            console.log("Update query:", updateQuery);
            console.log("Update params:", queryParams);

            const result = await client.query(updateQuery, queryParams);
            const updatedJobSeeker = result.rows[0];

            // Add history entry
            const historyQuery = `
                INSERT INTO job_seeker_history (
                    job_seeker_id,
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
                    after: updatedJobSeeker
                }),
                userId || jobSeeker.created_by
            ];

            await client.query(historyQuery, historyValues);

            // Commit transaction
            await client.query('COMMIT');

            console.log("Job seeker updated successfully:", updatedJobSeeker);
            return updatedJobSeeker;
        } catch (error) {
            // Rollback transaction in case of error
            await client.query('ROLLBACK');
            console.error("Error updating job seeker:", error);
            throw error;
        } finally {
            client.release();
        }
    }

    // Delete job seeker by ID
    async delete(id, userId = null) {
        const client = await this.pool.connect();
        try {
            // Begin transaction
            await client.query('BEGIN');

            // First, get the job seeker to ensure it exists and for audit
            const getJobSeekerQuery = 'SELECT * FROM job_seekers WHERE id = $1';
            const jobSeekerResult = await client.query(getJobSeekerQuery, [id]);

            if (jobSeekerResult.rows.length === 0) {
                throw new Error('Job seeker not found');
            }

            const jobSeeker = jobSeekerResult.rows[0];

            // If userId is provided (not admin/owner), check permission
            if (userId !== null && jobSeeker.created_by !== userId) {
                throw new Error('You do not have permission to delete this job seeker');
            }

            // Add an entry to history before deleting
            const historyQuery = `
                INSERT INTO job_seeker_history (
                    job_seeker_id,
                    action,
                    details,
                    performed_by
                )
                VALUES ($1, $2, $3, $4)
            `;

            const historyValues = [
                id,
                'DELETE',
                JSON.stringify(jobSeeker),
                userId || jobSeeker.created_by // Use original creator if no specific user
            ];

            await client.query(historyQuery, historyValues);

            // Release record_number back to pool for reuse
            if (jobSeeker.record_number != null) {
                await releaseRecordNumber(client, 'job_seeker', jobSeeker.record_number);
            }

            // Delete the job seeker
            const deleteQuery = 'DELETE FROM job_seekers WHERE id = $1 RETURNING *';
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

    // Add a note to a job seeker
    async addNote(jobSeekerId, text, userId) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // Insert the note
            const noteQuery = `
                INSERT INTO job_seeker_notes (job_seeker_id, text, created_by)
                VALUES ($1, $2, $3)
                RETURNING id, text, created_at
            `;

            const noteResult = await client.query(noteQuery, [jobSeekerId, text, userId]);

            // Add history entry for the note
            const historyQuery = `
                INSERT INTO job_seeker_history (
                    job_seeker_id,
                    action,
                    details,
                    performed_by
                )
                VALUES ($1, $2, $3, $4)
            `;

            const historyValues = [
                jobSeekerId,
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

    // Add this new method to the JobSeeker class in models/jobseeker.js

    // Add a note to a job seeker and automatically update last contact date
    async addNoteAndUpdateContact(jobSeekerId, text, userId, noteType = 'General Note', action = null, aboutReferences = null) {
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

            // Insert the note with note_type, action, and about_references
            const noteQuery = `
                INSERT INTO job_seeker_notes (job_seeker_id, text, note_type, action, about_references, created_by)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING *
            `;

            const noteResult = await client.query(noteQuery, [
                jobSeekerId,
                text,
                noteType,
                action,
                aboutReferencesJson ? JSON.stringify(aboutReferencesJson) : null,
                userId
            ]);

            // Update last contact date to current date
            const updateContactQuery = `
                UPDATE job_seekers 
                SET last_contact_date = CURRENT_DATE, updated_at = NOW()
                WHERE id = $1
            `;

            await client.query(updateContactQuery, [jobSeekerId]);

            // Add history entry for the note
            const historyQuery = `
                INSERT INTO job_seeker_history (
                    job_seeker_id,
                    action,
                    details,
                    performed_by
                )
                VALUES ($1, $2, $3, $4)
            `;

            const historyValues = [
                jobSeekerId,
                'ADD_NOTE',
                JSON.stringify({
                    noteId: noteResult.rows[0].id,
                    text,
                    noteType: noteType,
                    lastContactDateUpdated: true
                }),
                userId
            ];

            await client.query(historyQuery, historyValues);

            // Add history entry for last contact date update
            const contactHistoryQuery = `
                INSERT INTO job_seeker_history (
                    job_seeker_id,
                    action,
                    details,
                    performed_by
                )
                VALUES ($1, $2, $3, $4)
            `;

            const contactHistoryValues = [
                jobSeekerId,
                'UPDATE_CONTACT_DATE',
                JSON.stringify({
                    lastContactDate: new Date().toISOString().split('T')[0],
                    triggeredBy: 'note_addition',
                    noteId: noteResult.rows[0].id
                }),
                userId
            ];

            await client.query(contactHistoryQuery, contactHistoryValues);

            await client.query('COMMIT');

            console.log(`Note added and last contact date updated for job seeker ${jobSeekerId}`);

            return {
                ...noteResult.rows[0],
                lastContactDateUpdated: true
            };
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error adding note and updating contact date:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    // Keep the existing addNote method for backward compatibility but make it call the new method
    async addNote(jobSeekerId, text, userId, action = null, aboutReferences = null) {
        return await this.addNoteAndUpdateContact(jobSeekerId, text, userId, 'General Note', action, aboutReferences);
    }

    // Get notes for a job seeker
    async getNotes(jobSeekerId) {
        const client = await this.pool.connect();
        try {
            const query = `
                SELECT n.*, u.name as created_by_name
                FROM job_seeker_notes n
                LEFT JOIN users u ON n.created_by = u.id
                WHERE n.job_seeker_id = $1
                ORDER BY n.created_at DESC
            `;

            const result = await client.query(query, [jobSeekerId]);
            
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

    // Get history for a job seeker
    async getHistory(jobSeekerId) {
        const client = await this.pool.connect();
        try {
            const query = `
                SELECT h.*, u.name as performed_by_name
                FROM job_seeker_history h
                LEFT JOIN users u ON h.performed_by = u.id
                WHERE h.job_seeker_id = $1
                ORDER BY h.performed_at DESC
            `;

            const result = await client.query(query, [jobSeekerId]);
            return result.rows;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Count of job seekers who have at least one prescreen action note (in notes tab).
     * Excludes archived job seekers.
     */
    async getPrescreenedCount() {
        const client = await this.pool.connect();
        try {
            const query = `
                SELECT COUNT(DISTINCT n.job_seeker_id) AS count
                FROM job_seeker_notes n
                INNER JOIN job_seekers js ON js.id = n.job_seeker_id AND js.archived_at IS NULL
                WHERE (LOWER(COALESCE(n.action, n.note_type, '')) ~ 'pre\\s*screen|prescreen')
            `;
            const result = await client.query(query, []);
            return parseInt(result.rows[0]?.count || '0', 10);
        } finally {
            client.release();
        }
    }

    /**
     * Job seekers prescreened in the last 30 days by the given user.
     * Returns id, name, record_number, and latest prescreen note date for display/ordering.
     */
    async getPrescreenedByUserInLast30Days(userId) {
        const client = await this.pool.connect();
        try {
            const query = `
                SELECT js.id, js.first_name, js.last_name, js.record_number,
                       MAX(n.created_at) AS latest_prescreen_at
                FROM job_seekers js
                INNER JOIN job_seeker_notes n ON n.job_seeker_id = js.id
                WHERE js.archived_at IS NULL
                  AND n.created_by = $1
                  AND n.created_at >= NOW() - INTERVAL '30 days'
                  AND (LOWER(COALESCE(n.action, n.note_type, '')) ~ 'pre\\s*screen|prescreen')
                GROUP BY js.id, js.first_name, js.last_name, js.record_number
                ORDER BY latest_prescreen_at DESC
            `;
            const result = await client.query(query, [userId]);
            return result.rows.map((row) => ({
                id: row.id,
                name: [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || `#${row.record_number}`,
                record_number: row.record_number,
                latest_prescreen_at: row.latest_prescreen_at,
            }));
        } finally {
            client.release();
        }
    }
}

module.exports = JobSeeker;