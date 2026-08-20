const bcrypt = require('bcrypt');
const { allocateRecordNumber, releaseRecordNumber, runMigrationIfNeeded } = require('../services/recordNumberService');

class Task {
    constructor(pool) {
        this.pool = pool;
    }

    // Initialize the tasks table if it doesn't exist
    async initTable() {
        let client;
        try {
            console.log('Initializing tasks table if needed...');
            client = await this.pool.connect();

            await client.query(`
                CREATE TABLE IF NOT EXISTS tasks (
                    id SERIAL PRIMARY KEY,
                    title VARCHAR(255) NOT NULL,
                    description TEXT,
                    is_completed BOOLEAN DEFAULT false,
                    due_date DATE,
                    due_time TIME,
                    organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
                    job_seeker_id INTEGER REFERENCES job_seekers(id) ON DELETE CASCADE,
                    hiring_manager_id INTEGER REFERENCES hiring_managers(id),
                    job_id INTEGER REFERENCES jobs(id),
                    lead_id INTEGER REFERENCES leads(id),
                    placement_id INTEGER,
                    owner VARCHAR(255),
                    priority VARCHAR(20) DEFAULT 'Medium',
                    status VARCHAR(50) DEFAULT 'Pending',
                    created_by INTEGER REFERENCES users(id),
                    assigned_to INTEGER REFERENCES users(id),
                    completed_at TIMESTAMP,
                    completed_by INTEGER REFERENCES users(id),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    custom_fields JSONB,
                    archived_at TIMESTAMP,
                    archive_reason VARCHAR(50)
                )
            `);

            // Add organization_id column if it doesn't exist (for existing tables)
            await client.query(`
                DO $$ 
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns 
                        WHERE table_name='tasks' AND column_name='organization_id'
                    ) THEN
                        ALTER TABLE tasks ADD COLUMN organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;
                        CREATE INDEX IF NOT EXISTS idx_tasks_organization_id ON tasks(organization_id);
                    END IF;
                END $$;
            `);

            // Ensure organization_id uses ON DELETE CASCADE for existing installations
            await client.query(`
                ALTER TABLE tasks
                DROP CONSTRAINT IF EXISTS tasks_organization_id_fkey,
                ADD CONSTRAINT tasks_organization_id_fkey
                    FOREIGN KEY (organization_id)
                    REFERENCES organizations(id)
                    ON DELETE CASCADE
            `);

            // Reminder: minutes before due to send email to owner and assigned_to
            await client.query(`
                DO $$ 
                BEGIN
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='reminder_minutes_before_due') THEN
                        ALTER TABLE tasks ADD COLUMN reminder_minutes_before_due INTEGER;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='reminder_sent_at') THEN
                        ALTER TABLE tasks ADD COLUMN reminder_sent_at TIMESTAMP;
                    END IF;
                END $$;
            `);

            // Add archived_at and archive_reason columns if they don't exist (for existing tables)
            await client.query(`
                ALTER TABLE tasks ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP
            `);
            await client.query(`
                ALTER TABLE tasks ADD COLUMN IF NOT EXISTS archive_reason VARCHAR(50)
            `);
            await client.query(`
                ALTER TABLE tasks ADD COLUMN IF NOT EXISTS record_number INTEGER
            `);

            // Ensure job_seeker_id uses ON DELETE CASCADE for existing installations
            await client.query(`
                ALTER TABLE tasks
                DROP CONSTRAINT IF EXISTS tasks_job_seeker_id_fkey,
                ADD CONSTRAINT tasks_job_seeker_id_fkey
                    FOREIGN KEY (job_seeker_id)
                    REFERENCES job_seekers(id)
                    ON DELETE CASCADE
            `);

            // Create task notes table
            await client.query(`
                CREATE TABLE IF NOT EXISTS task_notes (
                    id SERIAL PRIMARY KEY,
                    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
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
                    WHERE table_schema='public' AND table_name='task_notes' AND column_name='action'
                `);
                if (actionColumnCheck.rows.length === 0) {
                    await client.query(`ALTER TABLE task_notes ADD COLUMN action VARCHAR(255)`);
                    console.log('✅ Migration: Added action column to task_notes');
                }
            } catch (err) {
                console.error('Error checking/adding action column:', err.message);
            }
            
            try {
                const aboutRefColumnCheck = await client.query(`
                    SELECT column_name 
                    FROM information_schema.columns 
                    WHERE table_schema='public' AND table_name='task_notes' AND column_name='about_references'
                `);
                if (aboutRefColumnCheck.rows.length === 0) {
                    await client.query(`ALTER TABLE task_notes ADD COLUMN about_references JSONB`);
                    console.log('✅ Migration: Added about_references column to task_notes');
                }
            } catch (err) {
                console.error('Error checking/adding about_references column:', err.message);
            }

            // Create task history table
            await client.query(`
                CREATE TABLE IF NOT EXISTS task_history (
                    id SERIAL PRIMARY KEY,
                    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                    action VARCHAR(50) NOT NULL,
                    details JSONB,
                    performed_by INTEGER REFERENCES users(id),
                    performed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            await runMigrationIfNeeded(client);

            console.log('✅ Tasks tables initialized successfully');
            return true;
        } catch (error) {
            console.error('❌ Error initializing tasks tables:', error.message);
            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // Create a new task
    async create(taskData) {
        const {
            title,
            description,
            isCompleted,
            dueDate,
            due_date, // Support snake_case
            dueTime,
            due_time, // Support snake_case
            organizationId,
            organization_id, // Support both formats
            jobSeekerId,
            job_seeker_id, // Support both formats
            hiringManagerId,
            hiring_manager_id, // Support both formats
            jobId,
            job_id, // Support both formats
            leadId,
            lead_id, // Support both formats
            placementId,
            placement_id, // Support both formats
            owner,
            priority,
            status,
            assignedTo,
            assigned_to, // Support both formats
            reminderMinutesBeforeDue,
            reminder_minutes_before_due,
            userId,
            customFields,
            custom_fields // Support both formats
        } = taskData;
        const finalReminderMinutes = reminderMinutesBeforeDue ?? reminder_minutes_before_due;
        
        // Support both camelCase and snake_case for date/time fields
        let finalDueDate = dueDate || due_date;
        let finalDueTime = dueTime || due_time;
        
        // Normalize due_time: extract time part if it's a datetime string
        if (finalDueTime && typeof finalDueTime === 'string') {
            const timeStr = finalDueTime.trim();
            // Check if it's a datetime string (contains 'T' or date pattern)
            if (timeStr.includes('T') || (timeStr.includes(' ') && timeStr.match(/\d{4}-\d{2}-\d{2}/))) {
                console.log(`[Task Model] Normalizing datetime string in due_time: ${timeStr}`);
                // Extract time part
                const separator = timeStr.includes('T') ? 'T' : ' ';
                const parts = timeStr.split(separator);
                if (parts.length >= 2) {
                    const timePart = parts[1];
                    const timeMatch = timePart.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
                    if (timeMatch) {
                        const [, h, m, sec] = timeMatch;
                        finalDueTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${(sec || '00').padStart(2, '0')}`;
                        console.log(`[Task Model] Extracted time: ${finalDueTime}`);
                    }
                    
                    // If due_date is not set, extract date from this datetime string
                    if (!finalDueDate && parts.length > 0) {
                        const datePart = parts[0];
                        const dateMatch = datePart.match(/^(\d{4}-\d{2}-\d{2})/);
                        if (dateMatch) {
                            finalDueDate = dateMatch[1];
                            console.log(`[Task Model] Extracted date: ${finalDueDate}`);
                        }
                    }
                } else {
                    console.warn(`[Task Model] Could not parse datetime string: ${timeStr}`);
                    finalDueTime = null;
                }
            } else {
                // Validate it's a valid time format (HH:MM:SS or HH:MM)
                const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
                if (timeMatch) {
                    const [, h, m, sec] = timeMatch;
                    finalDueTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${(sec || '00').padStart(2, '0')}`;
                } else {
                    console.warn(`[Task Model] Invalid time format: ${timeStr}, setting to null`);
                    finalDueTime = null;
                }
            }
        }

        // Use organizationId or organization_id (prefer organizationId)
        const finalOrganizationId = organizationId || organization_id;
        const finalJobSeekerId = jobSeekerId || job_seeker_id;
        const finalHiringManagerId = hiringManagerId || hiring_manager_id;
        const finalJobId = jobId || job_id;
        const finalLeadId = leadId || lead_id;
        const finalPlacementId = placementId || placement_id;
        const finalAssignedTo = assignedTo || assigned_to;
        const finalCustomFields = customFields || custom_fields || {};

        console.log("Task model - create function input:", JSON.stringify(taskData, null, 2));
        console.log("Mapped organizationId:", finalOrganizationId);
        console.log("Mapped customFields:", finalCustomFields);

        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            // Handle custom fields - accept both customFields and custom_fields
            let customFieldsJson = '{}';
            if (finalCustomFields) {
                if (typeof finalCustomFields === 'string') {
                    try {
                        // Validate it's valid JSON
                        JSON.parse(finalCustomFields);
                        customFieldsJson = finalCustomFields;
                    } catch (e) {
                        console.log("Invalid JSON string in customFields, using empty object");
                        customFieldsJson = '{}';
                    }
                } else if (typeof finalCustomFields === 'object') {
                    // Convert object to JSON string for JSONB storage
                    customFieldsJson = JSON.stringify(finalCustomFields);
                }
            }
            
            console.log("Custom fields JSON to insert:", customFieldsJson);

            const recordNumber = await allocateRecordNumber(client, 'task');

            const insertTaskQuery = `
                INSERT INTO tasks (
                    record_number,
                    title,
                    description,
                    is_completed,
                    due_date,
                    due_time,
                    organization_id,
                    job_seeker_id,
                    hiring_manager_id,
                    job_id,
                    lead_id,
                    placement_id,
                    owner,
                    priority,
                    status,
                    assigned_to,
                    created_by,
                    custom_fields,
                    reminder_minutes_before_due
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
                RETURNING *
            `;

            // Log date/time values for debugging
            console.log("Task model - dueDate:", finalDueDate);
            console.log("Task model - dueTime:", finalDueTime);
            
            const values = [
                recordNumber,
                title,
                description,
                isCompleted || false,
                finalDueDate || null,
                finalDueTime || null,
                finalOrganizationId ? parseInt(finalOrganizationId) : null,
                finalJobSeekerId ? parseInt(finalJobSeekerId) : null,
                finalHiringManagerId ? parseInt(finalHiringManagerId) : null,
                finalJobId ? parseInt(finalJobId) : null,
                finalLeadId ? parseInt(finalLeadId) : null,
                finalPlacementId ? parseInt(finalPlacementId) : null,
                owner,
                priority || 'Medium',
                status || 'Pending',
                finalAssignedTo && finalAssignedTo !== '' ? parseInt(finalAssignedTo) : null,
                userId,
                customFieldsJson,
                finalReminderMinutes != null ? parseInt(finalReminderMinutes) : null
            ];
            
            console.log("Insert values:", values);

            console.log("SQL Query:", insertTaskQuery);
            console.log("Query values:", values);

            const result = await client.query(insertTaskQuery, values);

            // Add history entry
            const historyQuery = `
                INSERT INTO task_history (
                    task_id,
                    action,
                    details,
                    performed_by
                )
                VALUES ($1, $2, $3, $4)
            `;

            const historyValues = [
                result.rows[0].id,
                'CREATE',
                JSON.stringify(taskData),
                userId
            ];

            await client.query(historyQuery, historyValues);

            await client.query('COMMIT');

            console.log("Created task:", result.rows[0]);
            return result.rows[0];
        } catch (error) {
            await client.query('ROLLBACK');
            console.error("Error in create task:", error);
            throw error;
        } finally {
            client.release();
        }
    }

    // Get all tasks (with optional filtering by created_by user)
    async getAll(userId = null) {
        const client = await this.pool.connect();
        try {
            let query = `
                SELECT t.*, 
                       u.name as created_by_name,
                       u2.name as assigned_to_name,
                       js.first_name || ' ' || js.last_name as job_seeker_name,
                       hm.first_name || ' ' || hm.last_name as hiring_manager_name,
                       j.job_title as job_title,
                       l.first_name || ' ' || l.last_name as lead_name,
                       uc.name as completed_by_name
                FROM tasks t
                LEFT JOIN users u ON t.created_by = u.id
                LEFT JOIN users u2 ON t.assigned_to = u2.id
                LEFT JOIN users uc ON t.completed_by = uc.id
                LEFT JOIN job_seekers js ON t.job_seeker_id = js.id
                LEFT JOIN hiring_managers hm ON t.hiring_manager_id = hm.id
                LEFT JOIN jobs j ON t.job_id = j.id
                LEFT JOIN leads l ON t.lead_id = l.id
            `;

            const values = [];

            if (userId) {
                query += ` WHERE (t.created_by = $1 OR t.assigned_to = $1)`;
                values.push(userId);
            }

            query += ` ORDER BY t.due_date ASC, t.created_at DESC`;

            const result = await client.query(query, values);
            return result.rows;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Get task by ID
    async getById(id, userId = null) {
        const client = await this.pool.connect();
        try {
            let query = `
                SELECT t.*, 
                       u.name as created_by_name,
                       u2.name as assigned_to_name,
                       js.first_name || ' ' || js.last_name as job_seeker_name,
                       hm.first_name || ' ' || hm.last_name as hiring_manager_name,
                       j.job_title as job_title,
                       l.first_name || ' ' || l.last_name as lead_name,
                       o.name as organization_name,
                       uc.name as completed_by_name
                FROM tasks t
                LEFT JOIN users u ON t.created_by = u.id
                LEFT JOIN users u2 ON t.assigned_to = u2.id
                LEFT JOIN users uc ON t.completed_by = uc.id
                LEFT JOIN job_seekers js ON t.job_seeker_id = js.id
                LEFT JOIN hiring_managers hm ON t.hiring_manager_id = hm.id
                LEFT JOIN jobs j ON t.job_id = j.id
                LEFT JOIN leads l ON t.lead_id = l.id
                LEFT JOIN organizations o ON t.organization_id = o.id
                WHERE t.id = $1
            `;

            const values = [id];

            if (userId) {
                query += ` AND (t.created_by = $2 OR t.assigned_to = $2)`;
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

    // Update task
    async update(id, updateData, userId = null) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // Get the current task
            const getTaskQuery = 'SELECT * FROM tasks WHERE id = $1';
            const taskResult = await client.query(getTaskQuery, [id]);

            if (taskResult.rows.length === 0) {
                throw new Error('Task not found');
            }

            const task = taskResult.rows[0];

            // Check permissions
            if (userId !== null && task.created_by !== userId && task.assigned_to !== userId) {
                throw new Error('You do not have permission to update this task');
            }

            const oldState = { ...task };

            // Build update query
            const updateFields = [];
            const queryParams = [];
            let paramCount = 1;

            const fieldMapping = {
                title: 'title',
                description: 'description',
                isCompleted: 'is_completed',
                dueDate: 'due_date',
                dueTime: 'due_time',
                organizationId: 'organization_id',
                jobSeekerId: 'job_seeker_id',
                hiringManagerId: 'hiring_manager_id',
                jobId: 'job_id',
                leadId: 'lead_id',
                placementId: 'placement_id',
                owner: 'owner',
                priority: 'priority',
                status: 'status',
                assignedTo: 'assigned_to',
                reminderMinutesBeforeDue: 'reminder_minutes_before_due',
                customFields: 'custom_fields'
            };

            // Handle completion logic
            if (updateData.isCompleted !== undefined) {
                if (updateData.isCompleted && !task.is_completed) {
                    // Task being completed
                    updateFields.push(`completed_at = NOW()`);
                    updateFields.push(`completed_by = $${paramCount}`);
                    queryParams.push(userId || task.created_by);
                    paramCount++;
                } else if (!updateData.isCompleted && task.is_completed) {
                    // Task being uncompleted
                    updateFields.push(`completed_at = NULL`);
                    updateFields.push(`completed_by = NULL`);
                }
            }

            // Handle custom fields merging - accept both customFields and custom_fields
            const updateCustomFieldsData = updateData.customFields || updateData.custom_fields;
            if (updateCustomFieldsData) {
                let newCustomFields = {};
                try {
                    const existingCustomFields = typeof task.custom_fields === 'string'
                        ? JSON.parse(task.custom_fields || '{}')
                        : (task.custom_fields || {});

                    const updateCustomFields = typeof updateCustomFieldsData === 'string'
                        ? JSON.parse(updateCustomFieldsData)
                        : updateCustomFieldsData;

                    newCustomFields = { ...existingCustomFields, ...updateCustomFields };
                } catch (e) {
                    console.error("Error parsing custom fields:", e);
                    newCustomFields = typeof updateData.customFields === 'string'
                        ? updateData.customFields
                        : JSON.stringify(updateData.customFields);
                }

                updateFields.push(`custom_fields = $${paramCount}`);
                queryParams.push(typeof newCustomFields === 'string'
                    ? newCustomFields
                    : JSON.stringify(newCustomFields));
                paramCount++;
            }

            // Process other fields
            for (const [key, value] of Object.entries(updateData)) {
                if (key !== 'customFields' && key !== 'custom_fields' && fieldMapping[key] && value !== undefined) {
                    updateFields.push(`${fieldMapping[key]} = $${paramCount}`);

                    // Handle numeric conversions
                    if (['organizationId', 'jobSeekerId', 'hiringManagerId', 'jobId', 'leadId', 'placementId', 'assignedTo'].includes(key)) {
                        queryParams.push(value ? parseInt(value) : null);
                    } else if (key === 'reminderMinutesBeforeDue') {
                        queryParams.push(value != null && value !== '' ? parseInt(value) : null);
                    } else if (key === 'isCompleted') {
                        queryParams.push(Boolean(value));
                    } else {
                        queryParams.push(value);
                    }
                    paramCount++;
                }
            }

            updateFields.push(`updated_at = NOW()`);

            if (updateFields.length === 1) {
                await client.query('ROLLBACK');
                return task;
            }

            const updateQuery = `
                UPDATE tasks 
                SET ${updateFields.join(', ')}
                WHERE id = $${paramCount}
                RETURNING *
            `;

            queryParams.push(id);

            const result = await client.query(updateQuery, queryParams);
            const updatedTask = result.rows[0];

            // Add history entry
            const historyQuery = `
                INSERT INTO task_history (
                    task_id,
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
                    after: updatedTask
                }),
                userId || task.created_by
            ];

            await client.query(historyQuery, historyValues);

            await client.query('COMMIT');

            console.log("Task updated successfully:", updatedTask);
            return updatedTask;
        } catch (error) {
            await client.query('ROLLBACK');
            console.error("Error updating task:", error);
            throw error;
        } finally {
            client.release();
        }
    }

    // Delete task
    async delete(id, userId = null) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const getTaskQuery = 'SELECT * FROM tasks WHERE id = $1';
            const taskResult = await client.query(getTaskQuery, [id]);

            if (taskResult.rows.length === 0) {
                throw new Error('Task not found');
            }

            const task = taskResult.rows[0];

            if (userId !== null && task.created_by !== userId) {
                throw new Error('You do not have permission to delete this task');
            }

            // Add history entry before deletion
            const historyQuery = `
                INSERT INTO task_history (
                    task_id,
                    action,
                    details,
                    performed_by
                )
                VALUES ($1, $2, $3, $4)
            `;

            const historyValues = [
                id,
                'DELETE',
                JSON.stringify(task),
                userId || task.created_by
            ];

            await client.query(historyQuery, historyValues);

            if (task.record_number != null) {
                await releaseRecordNumber(client, 'task', task.record_number);
            }

            // Delete the task
            const deleteQuery = 'DELETE FROM tasks WHERE id = $1 RETURNING *';
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

    // Get tasks that are due for reminder (within their reminder window, not yet sent)
    // Supports both reminder_minutes_before_due column and custom_fields->>'Reminder'
    async getTasksDueForReminder() {
        const client = await this.pool.connect();
        try {
            // Simplified query: fetch all tasks with reminders set, then filter in JavaScript
            // This is more reliable than complex SQL regex parsing
            const query = `
                SELECT t.id, t.title, t.description, t.due_date, t.due_time, t.owner, 
                       t.reminder_minutes_before_due,
                       t.custom_fields,
                       t.created_by, t.assigned_to,
                       t.organization_id, t.job_seeker_id, t.hiring_manager_id, t.job_id, t.lead_id,
                       u.email as created_by_email, u.name as created_by_name,
                       u2.email as assigned_to_email, u2.name as assigned_to_name,
                       o.name as organization_name,
                       hm.first_name || ' ' || hm.last_name as hiring_manager_name
                FROM tasks t
                LEFT JOIN users u ON t.created_by = u.id
                LEFT JOIN users u2 ON t.assigned_to = u2.id
                LEFT JOIN organizations o ON t.organization_id = o.id
                LEFT JOIN hiring_managers hm ON t.hiring_manager_id = hm.id
                WHERE t.reminder_sent_at IS NULL
                  AND (t.is_completed IS NULL OR t.is_completed = false)
                  AND t.due_date IS NOT NULL
                  AND (
                    -- Has reminder_minutes_before_due set (legacy)
                    t.reminder_minutes_before_due IS NOT NULL
                    OR
                    -- Has Reminder custom field set (new)
                    (t.custom_fields->>'Reminder' IS NOT NULL 
                     AND t.custom_fields->>'Reminder' != ''
                     AND t.custom_fields->>'Reminder' != 'None')
                  )
            `;
            const result = await client.query(query);
            
            // Also query for tasks that have due_date but don't match reminder criteria (for debugging)
            const debugQuery = `
                SELECT t.id, t.title, t.due_date, t.due_time,
                       t.reminder_minutes_before_due,
                       t.custom_fields,
                       t.reminder_sent_at,
                       t.is_completed
                FROM tasks t
                WHERE t.due_date IS NOT NULL
                  AND (
                    t.reminder_sent_at IS NOT NULL
                    OR t.is_completed = true
                    OR (t.reminder_minutes_before_due IS NULL 
                        AND (t.custom_fields->>'Reminder' IS NULL 
                             OR t.custom_fields->>'Reminder' = ''
                             OR t.custom_fields->>'Reminder' = 'None'))
                  )
                ORDER BY t.due_date DESC, t.due_time DESC
                LIMIT 10
            `;
            const debugResult = await client.query(debugQuery);
            if (debugResult.rows.length > 0) {
                console.log(`[getTasksDueForReminder] Found ${debugResult.rows.length} task(s) with due_date but excluded from reminders:`, 
                    debugResult.rows.map(r => ({
                        id: r.id,
                        title: r.title,
                        due_date: r.due_date,
                        due_time: r.due_time,
                        reminder_sent_at: r.reminder_sent_at,
                        is_completed: r.is_completed,
                        reminder_minutes_before_due: r.reminder_minutes_before_due,
                        custom_fields_reminder: r.custom_fields?.Reminder || r.custom_fields?.['Reminder']
                    }))
                );
            }
            
            // Helper function to parse reminder string to minutes
            const parseReminderToMinutes = (reminderValue) => {
                if (!reminderValue) return null;
                if (typeof reminderValue === 'number') return reminderValue;
                const str = String(reminderValue).toLowerCase().trim();
                if (str === '' || str === 'none' || str === 'null') return null;
                
                // Match patterns like "5 minutes", "1 hour", "1 day", "5", etc.
                const match = str.match(/(\d+)\s*(minute|minutes|min|hour|hours|hr|day|days|d|h|m)?/i);
                if (!match) return null;
                
                const num = parseInt(match[1], 10);
                const unit = match[2]?.toLowerCase() || 'minute';
                
                if (unit.startsWith('d') || unit === 'day') return num * 1440; // days to minutes
                if (unit.startsWith('h') || unit === 'hour' || unit === 'hr') return num * 60; // hours to minutes
                return num; // minutes
            };
            
            // Filter tasks where reminder time has passed
            const now = new Date();
            console.log(`[getTasksDueForReminder] Current time: ${now.toISOString()} (UTC)`);
            console.log(`[getTasksDueForReminder] Found ${result.rows.length} task(s) with reminders configured`);
            
            const processedRows = result.rows.filter(row => {
                let reminderMinutes = row.reminder_minutes_before_due;
                
                // Parse custom_fields Reminder if reminder_minutes_before_due is not set
                if (!reminderMinutes && row.custom_fields) {
                    const reminderValue = row.custom_fields.Reminder || row.custom_fields['Reminder'];
                    reminderMinutes = parseReminderToMinutes(reminderValue);
                }
                
                if (!reminderMinutes || reminderMinutes <= 0) {
                    console.log(`[getTasksDueForReminder] Task ${row.id}: Invalid reminder value (${reminderMinutes})`);
                    return false;
                }
                
                // Calculate reminder time
                if (!row.due_date) {
                    console.log(`[getTasksDueForReminder] Task ${row.id}: No due_date`);
                    return false;
                }
                
                // Parse due_date - handle both date-only and datetime strings
                // PostgreSQL DATE type is returned as a string "YYYY-MM-DD" (date-only)
                // PostgreSQL TIMESTAMP is returned as a string with time info
                let dueDate;
                const dueDateStr = row.due_date instanceof Date 
                    ? row.due_date.toISOString().split('T')[0] 
                    : String(row.due_date);
                
                // Check if due_date includes time information
                const hasTimeInfo = dueDateStr.includes('T') || dueDateStr.includes(' ') || 
                                   (row.due_date instanceof Date && row.due_date.getHours() !== 0);
                
                if (row.due_date instanceof Date) {
                    // Already a Date object, clone it
                    dueDate = new Date(row.due_date);
                } else if (hasTimeInfo) {
                    // Full datetime string, parse directly
                    dueDate = new Date(dueDateStr);
                } else {
                    // Date-only string (YYYY-MM-DD), create date at midnight UTC
                    // This ensures consistent timezone handling
                    dueDate = new Date(dueDateStr + 'T00:00:00Z');
                }
                
                // Handle due_time if provided (separate field from due_date)
                if (row.due_time) {
                    const [hours, minutes, seconds] = row.due_time.split(':');
                    const hour = parseInt(hours || 0, 10);
                    const min = parseInt(minutes || 0, 10);
                    const sec = parseInt(seconds || 0, 10);
                    
                    // If due_date was date-only (no time info), set time in UTC
                    // This ensures the time is interpreted consistently regardless of server timezone
                    if (!hasTimeInfo) {
                        // Date-only was parsed as UTC midnight, set UTC time
                        dueDate.setUTCHours(hour, min, sec, 0);
                    } else {
                        // Full datetime already has time, but due_time overrides it
                        // Set in UTC to maintain consistency
                        dueDate.setUTCHours(hour, min, sec, 0);
                    }
                } else if (!hasTimeInfo) {
                    // No due_time and date-only, ensure we're at midnight UTC
                    dueDate.setUTCHours(0, 0, 0, 0);
                }
                
                // Calculate reminder time (subtract reminder minutes from due date/time)
                const reminderTime = new Date(dueDate.getTime() - (reminderMinutes * 60 * 1000));
                
                // Check if reminder time has passed (compare in UTC)
                const shouldRemind = reminderTime <= now;
                
                // Debug logging for each task
                console.log(`[getTasksDueForReminder] Task ${row.id} "${row.title}":`, {
                    due_date_raw: row.due_date,
                    due_time_raw: row.due_time,
                    reminder_minutes: reminderMinutes,
                    due_date_parsed: dueDate.toISOString(),
                    reminder_time: reminderTime.toISOString(),
                    current_time: now.toISOString(),
                    should_remind: shouldRemind,
                    time_until_reminder: shouldRemind ? 'PAST' : `${Math.round((reminderTime - now) / 60000)} minutes`
                });
                
                if (shouldRemind) {
                    // Set reminder_minutes_before_due for consistency
                    row.reminder_minutes_before_due = reminderMinutes;
                }
                
                return shouldRemind;
            });
            
            console.log(`[getTasksDueForReminder] Returning ${processedRows.length} task(s) due for reminder`);
            
            return processedRows;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    async markReminderSent(taskId) {
        const client = await this.pool.connect();
        try {
            await client.query(
                'UPDATE tasks SET reminder_sent_at = NOW() WHERE id = $1',
                [taskId]
            );
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Diagnostic method to check why tasks aren't matching reminder criteria
    async diagnoseReminderIssues(dueDateFilter = null) {
        const client = await this.pool.connect();
        try {
            let query = `
                SELECT t.id, t.title, t.due_date, t.due_time, 
                       t.reminder_minutes_before_due,
                       t.custom_fields,
                       t.reminder_sent_at,
                       t.is_completed,
                       CASE 
                           WHEN t.reminder_sent_at IS NOT NULL THEN 'reminder_sent_at is set'
                           WHEN t.is_completed = true THEN 'task is completed'
                           WHEN t.due_date IS NULL THEN 'no due_date'
                           WHEN t.reminder_minutes_before_due IS NULL 
                                AND (t.custom_fields->>'Reminder' IS NULL 
                                     OR t.custom_fields->>'Reminder' = ''
                                     OR t.custom_fields->>'Reminder' = 'None') 
                           THEN 'no reminder field set'
                           ELSE 'should match'
                       END as reason_not_matching
                FROM tasks t
                WHERE 1=1
            `;
            
            const params = [];
            if (dueDateFilter) {
                // More flexible date matching - check both date and datetime formats
                query += ` AND (
                    t.due_date::text LIKE $1 
                    OR t.due_date::date::text = $1
                    OR (t.due_date::text LIKE $2 AND t.due_time::text LIKE $3)
                )`;
                params.push(`${dueDateFilter}%`, `${dueDateFilter}%`, `%`);
            } else {
                // If no filter, only show tasks with due_date
                query += ` AND t.due_date IS NOT NULL`;
            }
            
            query += ` ORDER BY t.due_date DESC, t.due_time DESC LIMIT 50`;
            
            const result = await client.query(query, params);
            
            const now = new Date();
            const diagnostics = result.rows.map(row => {
                const reminderValue = row.reminder_minutes_before_due || 
                    (row.custom_fields?.Reminder || row.custom_fields?.['Reminder']);
                
                let reminderTime = null;
                let timeUntilReminder = null;
                
                if (row.due_date && reminderValue) {
                    try {
                        const dueDateStr = String(row.due_date);
                        let dueDate = new Date(dueDateStr.includes('T') || dueDateStr.includes(' ') 
                            ? dueDateStr 
                            : dueDateStr + 'T00:00:00Z');
                        
                        if (row.due_time) {
                            const [h, m, s] = row.due_time.split(':');
                            if (!dueDateStr.includes('T') && !dueDateStr.includes(' ')) {
                                dueDate.setUTCHours(parseInt(h || 0), parseInt(m || 0), parseInt(s || 0), 0);
                            } else {
                                dueDate.setHours(parseInt(h || 0), parseInt(m || 0), parseInt(s || 0), 0);
                            }
                        }
                        
                        const reminderMinutes = typeof reminderValue === 'number' 
                            ? reminderValue 
                            : parseInt(String(reminderValue).match(/(\d+)/)?.[1] || '0');
                        
                        if (reminderMinutes > 0) {
                            reminderTime = new Date(dueDate.getTime() - (reminderMinutes * 60 * 1000));
                            timeUntilReminder = Math.round((reminderTime - now) / 60000);
                        }
                    } catch (e) {
                        // Ignore parsing errors
                    }
                }
                
                return {
                    id: row.id,
                    title: row.title,
                    due_date: row.due_date,
                    due_time: row.due_time,
                    reminder_minutes_before_due: row.reminder_minutes_before_due,
                    custom_fields_reminder: row.custom_fields?.Reminder || row.custom_fields?.['Reminder'],
                    reminder_sent_at: row.reminder_sent_at,
                    is_completed: row.is_completed,
                    reason_not_matching: row.reason_not_matching,
                    reminder_time: reminderTime ? reminderTime.toISOString() : null,
                    time_until_reminder_minutes: timeUntilReminder,
                    current_time: now.toISOString()
                };
            });
            
            return diagnostics;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Find tasks by specific due date/time (for debugging)
    async findTasksByDueDateTime(dueDateStr) {
        const client = await this.pool.connect();
        try {
            // Try multiple date formats
            const queries = [
                // Exact match with time
                `SELECT t.*, t.due_date::text as due_date_str, t.due_time::text as due_time_str
                 FROM tasks t 
                 WHERE t.due_date::text LIKE $1 
                 ORDER BY t.id DESC LIMIT 10`,
                // Date only match
                `SELECT t.*, t.due_date::text as due_date_str, t.due_time::text as due_time_str
                 FROM tasks t 
                 WHERE t.due_date::date::text = $1 
                 ORDER BY t.id DESC LIMIT 10`,
                // Match any task with date containing the search string
                `SELECT t.*, t.due_date::text as due_date_str, t.due_time::text as due_time_str
                 FROM tasks t 
                 WHERE t.due_date::text LIKE $2 
                 ORDER BY t.id DESC LIMIT 10`
            ];

            const dateOnly = dueDateStr.split('T')[0];
            const results = [];

            for (const query of queries) {
                try {
                    const result = await client.query(query, [
                        dueDateStr,
                        `${dateOnly}%`
                    ]);
                    if (result.rows.length > 0) {
                        results.push(...result.rows);
                    }
                } catch (e) {
                    // Continue to next query
                }
            }

            // Remove duplicates
            const uniqueResults = results.filter((task, index, self) =>
                index === self.findIndex(t => t.id === task.id)
            );

            return uniqueResults;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Add a note to a task
    async addNote(taskId, text, userId, action = null, aboutReferences = null) {
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

            const noteQuery = `
                INSERT INTO task_notes (task_id, text, action, about_references, created_by)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING *
            `;

            const noteResult = await client.query(noteQuery, [
                taskId,
                text,
                action,
                aboutReferencesJson ? JSON.stringify(aboutReferencesJson) : null,
                userId
            ]);

            // Add history entry
            const historyQuery = `
                INSERT INTO task_history (
                    task_id,
                    action,
                    details,
                    performed_by
                )
                VALUES ($1, $2, $3, $4)
            `;

            const historyValues = [
                taskId,
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

    // Get notes for a task
    async getNotes(taskId) {
        const client = await this.pool.connect();
        try {
            const query = `
                SELECT n.*, u.name as created_by_name
                FROM task_notes n
                LEFT JOIN users u ON n.created_by = u.id
                WHERE n.task_id = $1
                ORDER BY n.created_at DESC
            `;

            const result = await client.query(query, [taskId]);
            
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

    // Get history for a task
    async getHistory(taskId) {
        const client = await this.pool.connect();
        try {
            const query = `
                SELECT h.*, u.name as performed_by_name
                FROM task_history h
                LEFT JOIN users u ON h.performed_by = u.id
                WHERE h.task_id = $1
                ORDER BY h.performed_at DESC
            `;

            const result = await client.query(query, [taskId]);
            return result.rows;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Get task statistics
    async getStats(userId = null) {
        const client = await this.pool.connect();
        try {
            let query = `
                SELECT 
                    COUNT(*) as total_tasks,
                    COUNT(CASE WHEN is_completed = true THEN 1 END) as completed_tasks,
                    COUNT(CASE WHEN is_completed = false THEN 1 END) as pending_tasks,
                    COUNT(CASE WHEN due_date < CURRENT_DATE AND is_completed = false THEN 1 END) as overdue_tasks,
                    COUNT(CASE WHEN due_date = CURRENT_DATE AND is_completed = false THEN 1 END) as due_today
                FROM tasks
            `;

            const values = [];

            if (userId) {
                query += ` WHERE (created_by = $1 OR assigned_to = $1)`;
                values.push(userId);
            }

            const result = await client.query(query, values);
            return result.rows[0];
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }
}

module.exports = Task;