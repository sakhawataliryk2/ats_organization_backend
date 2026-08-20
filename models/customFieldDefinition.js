// models/customFieldDefinition.js
class CustomFieldDefinition {
    constructor(pool) {
        this.pool = pool;
    }

    // Initialize the custom_field_definitions table
    async initTable() {
        let client;
        try {
            console.log('Initializing custom_field_definitions table if needed...');
            client = await this.pool.connect();

            // Update the main table to include updated_by field
            await client.query(`
                CREATE TABLE IF NOT EXISTS custom_field_definitions (
                    id SERIAL PRIMARY KEY,
                    entity_type VARCHAR(50) NOT NULL,
                    field_name VARCHAR(100) NOT NULL,
                    field_label VARCHAR(255) NOT NULL,
                    field_type VARCHAR(50) NOT NULL DEFAULT 'text',
                    is_required BOOLEAN DEFAULT false,
                    is_hidden BOOLEAN DEFAULT false,
                    sort_order INTEGER DEFAULT 0,
                    options JSONB,
                    placeholder VARCHAR(255),
                    default_value TEXT,
                    validation_rules JSONB,
                    lookup_type VARCHAR(50),
                    created_by INTEGER REFERENCES users(id),
                    updated_by INTEGER REFERENCES users(id),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(entity_type, field_name)
                )
            `);

            // Add updated_by column if it doesn't exist (for existing installations)
            await client.query(`
                ALTER TABLE custom_field_definitions 
                ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id)
            `);

            // Add lookup_type column if it doesn't exist (for existing installations)
            await client.query(`
                ALTER TABLE custom_field_definitions 
                ADD COLUMN IF NOT EXISTS lookup_type VARCHAR(50)
            `);

            // Add is_read_only and sub_field_ids for new field types (composite, read-only)
            await client.query(`
                ALTER TABLE custom_field_definitions 
                ADD COLUMN IF NOT EXISTS is_read_only BOOLEAN DEFAULT false
            `);
            await client.query(`
                ALTER TABLE custom_field_definitions 
                ADD COLUMN IF NOT EXISTS sub_field_ids JSONB
            `);

            // Create history table for tracking changes
            await client.query(`
                CREATE TABLE IF NOT EXISTS custom_field_definition_history (
                    id SERIAL PRIMARY KEY,
                    field_definition_id INTEGER NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
                    action VARCHAR(50) NOT NULL,
                    old_values JSONB,
                    new_values JSONB,
                    changed_fields TEXT[],
                    performed_by INTEGER REFERENCES users(id),
                    performed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Auto-correct existing invalid records: fields that are both Hidden and Required
            // Preference: Keep required=true, set hidden=false
            await client.query(`
                UPDATE custom_field_definitions
                SET is_hidden = false, updated_at = CURRENT_TIMESTAMP
                WHERE is_required = true AND is_hidden = true
            `);

            console.log('✅ Custom field definitions table initialized successfully');
            return true;
        } catch (error) {
            console.error('❌ Error initializing custom field definitions table:', error.message);
            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // Create a new custom field definition
    async create(fieldData) {
        const {
            entityType,
            fieldName,
            fieldLabel,
            fieldType,
            isRequired,
            isHidden,
            isReadOnly,
            sortOrder,
            options,
            placeholder,
            defaultValue,
            validationRules,
            lookupType,
            subFieldIds,
            userId
        } = fieldData;

        const effectiveRequired = isReadOnly ? false : (isRequired || false);

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const query = `
                INSERT INTO custom_field_definitions (
                    entity_type, field_name, field_label, field_type,
                    is_required, is_hidden, is_read_only, sort_order, options,
                    placeholder, default_value, validation_rules, lookup_type, sub_field_ids,
                    created_by, updated_by
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)
                RETURNING *
            `;

            const values = [
                entityType,
                fieldName,
                fieldLabel,
                fieldType || 'text',
                effectiveRequired,
                isHidden || false,
                Boolean(isReadOnly),
                sortOrder || 0,
                options ? JSON.stringify(options) : null,
                placeholder,
                defaultValue,
                validationRules ? JSON.stringify(validationRules) : null,
                lookupType || null,
                subFieldIds && Array.isArray(subFieldIds) ? JSON.stringify(subFieldIds) : null,
                userId
            ];

            const result = await client.query(query, values);
            const newField = result.rows[0];

            // Add history entry for creation
            await this.addHistoryEntry(client, newField.id, 'CREATE', null, newField, userId);

            await client.query('COMMIT');
            return newField;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    // Get all custom field definitions for an entity type
    async getByEntityType(entityType) {
        const client = await this.pool.connect();
        try {
            const query = `
                SELECT cfd.*, 
                       u.name as created_by_name,
                       u2.name as updated_by_name
                FROM custom_field_definitions cfd
                LEFT JOIN users u ON cfd.created_by = u.id
                LEFT JOIN users u2 ON cfd.updated_by = u2.id
                WHERE cfd.entity_type = $1
                ORDER BY cfd.sort_order, cfd.created_at
            `;

            const result = await client.query(query, [entityType]);
            return result.rows;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Update a custom field definition with enhanced history tracking
    async update(id, updateData, userId) {
        if (!id || !Number.isInteger(Number(id)) || Number(id) <= 0) {
            throw new Error('Invalid custom field ID');
        }

        if (!updateData || Object.keys(updateData).length === 0) {
            throw new Error('No update data provided');
        }

        if (!userId || !Number.isInteger(Number(userId)) || Number(userId) <= 0) {
            throw new Error('Invalid user ID');
        }

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // First get the current field data for history
            const currentFieldQuery = 'SELECT * FROM custom_field_definitions WHERE id = $1';
            const currentFieldResult = await client.query(currentFieldQuery, [id]);

            if (currentFieldResult.rows.length === 0) {
                throw new Error('Custom field definition not found');
            }

            const oldValues = currentFieldResult.rows[0];

            // Read-only: when true, required must be false
            if (updateData.isReadOnly === true) {
                updateData.isRequired = false;
            }

            // Critical: Validate Hidden & Required mutual exclusivity before update
            const finalIsRequired = updateData.isRequired !== undefined 
                ? updateData.isRequired 
                : oldValues.is_required;
            const finalIsHidden = updateData.isHidden !== undefined 
                ? updateData.isHidden 
                : oldValues.is_hidden;

            // Enforce mutual exclusivity: if both would be true, prefer setting hidden to false
            if (finalIsRequired === true && finalIsHidden === true) {
                if (updateData.isRequired !== undefined && updateData.isRequired === true) {
                    updateData.isHidden = false;
                } else if (updateData.isHidden !== undefined && updateData.isHidden === true) {
                    updateData.isRequired = false;
                } else {
                    updateData.isHidden = false;
                }
            }

            // Build the update query dynamically
            const updateFields = [];
            const queryParams = [];
            let paramCount = 1;

            // Field mapping from frontend to database
            const fieldMapping = {
                fieldName: 'field_name',
                fieldLabel: 'field_label',
                fieldType: 'field_type',
                isRequired: 'is_required',
                isHidden: 'is_hidden',
                isReadOnly: 'is_read_only',
                sortOrder: 'sort_order',
                placeholder: 'placeholder',
                defaultValue: 'default_value',
                lookupType: 'lookup_type',
                subFieldIds: 'sub_field_ids'
            };

            // Process regular fields
            for (const [key, value] of Object.entries(updateData)) {
                if (fieldMapping[key] && value !== undefined) {
                    updateFields.push(`${fieldMapping[key]} = $${paramCount}`);
                    queryParams.push(value);
                    paramCount++;
                }
            }

            // Handle JSON fields separately
            if (updateData.options !== undefined) {
                updateFields.push(`options = $${paramCount}`);
                queryParams.push(updateData.options ? JSON.stringify(updateData.options) : null);
                paramCount++;
            }

            if (updateData.validationRules !== undefined) {
                updateFields.push(`validation_rules = $${paramCount}`);
                queryParams.push(updateData.validationRules ? JSON.stringify(updateData.validationRules) : null);
                paramCount++;
            }

            if (updateData.subFieldIds !== undefined) {
                updateFields.push(`sub_field_ids = $${paramCount}`);
                queryParams.push(updateData.subFieldIds && Array.isArray(updateData.subFieldIds) ? JSON.stringify(updateData.subFieldIds) : null);
                paramCount++;
            }

            // Always update the updated_by and updated_at fields
            updateFields.push(`updated_by = $${paramCount}`);
            queryParams.push(userId);
            paramCount++;

            updateFields.push(`updated_at = NOW()`);

            // If no fields to update (only updated_by and updated_at), just return current data
            if (updateFields.length === 2) {
                await client.query('ROLLBACK');
                return await this.getById(id);
            }

            // Build and execute the update query
            const updateQuery = `
                UPDATE custom_field_definitions 
                SET ${updateFields.join(', ')}
                WHERE id = $${paramCount}
                RETURNING *
            `;

            queryParams.push(id);
            
            console.log('Update query:', updateQuery);
            console.log('Query params:', queryParams);

            const result = await client.query(updateQuery, queryParams);
            
            if (result.rows.length === 0) {
                throw new Error('Custom field definition not found');
            }

            const newValues = result.rows[0];

            // Determine what fields changed for history tracking
            const changedFields = [];
            
            // Check regular fields
            for (const [key, dbKey] of Object.entries(fieldMapping)) {
                if (updateData[key] !== undefined) {
                    const oldValue = oldValues[dbKey];
                    const newValue = newValues[dbKey];
                    
                    // Handle different data types for comparison
                    if (typeof oldValue === 'boolean' && typeof newValue === 'boolean') {
                        if (oldValue !== newValue) {
                            changedFields.push(dbKey);
                        }
                    } else if (oldValue !== newValue) {
                        changedFields.push(dbKey);
                    }
                }
            }

            // Check JSON fields
            if (updateData.options !== undefined) {
                const oldOptions = oldValues.options ? JSON.stringify(oldValues.options) : null;
                const newOptions = newValues.options ? JSON.stringify(newValues.options) : null;
                if (oldOptions !== newOptions) {
                    changedFields.push('options');
                }
            }

            if (updateData.validationRules !== undefined) {
                const oldRules = oldValues.validation_rules ? JSON.stringify(oldValues.validation_rules) : null;
                const newRules = newValues.validation_rules ? JSON.stringify(newValues.validation_rules) : null;
                if (oldRules !== newRules) {
                    changedFields.push('validation_rules');
                }
            }

            // Add history entry for the update (only if there were actual changes)
            if (changedFields.length > 0) {
                await this.addHistoryEntry(client, id, 'UPDATE', oldValues, newValues, userId, changedFields);
            }

            await client.query('COMMIT');
            return newValues;

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error in custom field update:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    // Delete a custom field definition
    async delete(id, userId) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // Get the field data before deletion for history
            const fieldQuery = 'SELECT * FROM custom_field_definitions WHERE id = $1';
            const fieldResult = await client.query(fieldQuery, [id]);

            if (fieldResult.rows.length === 0) {
                throw new Error('Custom field definition not found');
            }

            const fieldData = fieldResult.rows[0];

            // Add history entry for deletion
            await this.addHistoryEntry(client, id, 'DELETE', fieldData, null, userId);

            // Delete the field
            const deleteQuery = 'DELETE FROM custom_field_definitions WHERE id = $1 RETURNING *';
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

    // Get a custom field definition by ID
    async getById(id) {
        const client = await this.pool.connect();
        try {
            const query = `
                SELECT cfd.*, 
                       u.name as created_by_name,
                       u2.name as updated_by_name
                FROM custom_field_definitions cfd
                LEFT JOIN users u ON cfd.created_by = u.id
                LEFT JOIN users u2 ON cfd.updated_by = u2.id
                WHERE cfd.id = $1
            `;

            const result = await client.query(query, [id]);
            return result.rows[0] || null;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Get history for a custom field definition
    async getHistory(fieldDefinitionId) {
        const client = await this.pool.connect();
        try {
            const query = `
                SELECT h.*, u.name as performed_by_name
                FROM custom_field_definition_history h
                LEFT JOIN users u ON h.performed_by = u.id
                WHERE h.field_definition_id = $1
                ORDER BY h.performed_at DESC
            `;

            const result = await client.query(query, [fieldDefinitionId]);
            return result.rows;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Helper method to add history entries
    async addHistoryEntry(client, fieldDefinitionId, action, oldValues, newValues, userId, changedFields = []) {
        const historyQuery = `
            INSERT INTO custom_field_definition_history (
                field_definition_id, action, old_values, new_values, 
                changed_fields, performed_by
            )
            VALUES ($1, $2, $3, $4, $5, $6)
        `;

        const historyValues = [
            fieldDefinitionId,
            action,
            oldValues ? JSON.stringify(oldValues) : null,
            newValues ? JSON.stringify(newValues) : null,
            changedFields,
            userId
        ];

        await client.query(historyQuery, historyValues);
    }
}

module.exports = CustomFieldDefinition;