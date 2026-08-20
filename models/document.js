// models/document.js
class Document {
    constructor(pool) {
        this.pool = pool;
    }

    // Initialize the documents table if it doesn't exist
    async initTable() {
        let client;
        try {
            console.log('Initializing documents table if needed...');
            client = await this.pool.connect();

            await client.query(`
                CREATE TABLE IF NOT EXISTS documents (
                    id SERIAL PRIMARY KEY,
                    entity_type VARCHAR(50) NOT NULL,
                    entity_id INTEGER NOT NULL,
                    document_name VARCHAR(255) NOT NULL,
                    document_type VARCHAR(50),
                    file_path TEXT,
                    file_size INTEGER,
                    mime_type VARCHAR(100),
                    is_auto_generated BOOLEAN DEFAULT FALSE,
                    content TEXT,
                    created_by INTEGER REFERENCES users(id),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            await client.query(`
                ALTER TABLE documents
                ADD COLUMN IF NOT EXISTS source_template_document_id INTEGER
            `);

            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_documents_source_template
                ON documents(source_template_document_id)
                WHERE source_template_document_id IS NOT NULL
            `);

            // Create index for faster lookups
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_documents_entity 
                ON documents(entity_type, entity_id)
            `);

            console.log('Documents table initialized successfully');
        } catch (error) {
            console.error('Error initializing documents table:', error);
            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // Create a new document
    async create(documentData) {
        const {
            entity_type,
            entity_id,
            document_name,
            document_type,
            file_path,
            file_size,
            mime_type,
            is_auto_generated,
            content,
            created_by,
            source_template_document_id
        } = documentData;

        let client;
        try {
            client = await this.pool.connect();

            const query = `
                INSERT INTO documents (
                    entity_type, entity_id, document_name, document_type,
                    file_path, file_size, mime_type, is_auto_generated,
                    content, created_by, source_template_document_id, created_at, updated_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                RETURNING *
            `;

            const values = [
                entity_type,
                entity_id,
                document_name,
                document_type || 'General',
                file_path || null,
                file_size || null,
                mime_type || 'text/plain',
                is_auto_generated || false,
                content || null,
                created_by,
                source_template_document_id || null
            ];

            const result = await client.query(query, values);
            return result.rows[0];
        } catch (error) {
            console.error('Error creating document:', error);
            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // Get all documents for a specific entity
    async getByEntity(entity_type, entity_id) {
        let client;
        try {
            client = await this.pool.connect();

            const query = `
                SELECT d.*, u.name as created_by_name
                FROM documents d
                LEFT JOIN users u ON d.created_by = u.id
                WHERE d.entity_type = $1 AND d.entity_id = $2
                ORDER BY d.created_at DESC
            `;

            const result = await client.query(query, [entity_type, entity_id]);
            return result.rows;
        } catch (error) {
            console.error('Error fetching documents:', error);
            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // Get all documents for multiple entities of the same type
    async getByEntities(entity_type, entity_ids) {
        if (!entity_ids || entity_ids.length === 0) return [];

        let client;
        try {
            client = await this.pool.connect();

            const query = `
                SELECT d.*, u.name as created_by_name
                FROM documents d
                LEFT JOIN users u ON d.created_by = u.id
                WHERE d.entity_type = $1 AND d.entity_id = ANY($2::int[])
                ORDER BY d.created_at DESC
            `;

            const result = await client.query(query, [entity_type, entity_ids]);
            return result.rows;
        } catch (error) {
            console.error('Error fetching documents by entities:', error);
            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // Get document by ID
    async getById(id) {
        let client;
        try {
            client = await this.pool.connect();

            const query = `
                SELECT d.*, u.name as created_by_name
                FROM documents d
                LEFT JOIN users u ON d.created_by = u.id
                WHERE d.id = $1
            `;

            const result = await client.query(query, [id]);
            return result.rows[0] || null;
        } catch (error) {
            console.error('Error fetching document:', error);
            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // Update document
    async update(id, documentData) {
        const {
            document_name,
            document_type,
            content,
            file_path,
            file_size,
            mime_type
        } = documentData;

        let client;
        try {
            client = await this.pool.connect();

            const updates = ['document_name = COALESCE($1, document_name)', 'document_type = COALESCE($2, document_type)', 'content = COALESCE($3, content)'];
            const values = [document_name ?? null, document_type ?? null, content ?? null];
            let idx = 4;
            if (file_path !== undefined) { updates.push(`file_path = $${idx}`); values.push(file_path); idx++; }
            if (file_size !== undefined) { updates.push(`file_size = $${idx}`); values.push(file_size); idx++; }
            if (mime_type !== undefined) { updates.push(`mime_type = $${idx}`); values.push(mime_type); idx++; }
            values.push(id);
            const query = `
                UPDATE documents
                SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
                WHERE id = $${idx}
                RETURNING *
            `;
            const result = await client.query(query, values);
            return result.rows[0];
        } catch (error) {
            console.error('Error updating document:', error);
            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // Delete document
    async delete(id) {
        let client;
        try {
            client = await this.pool.connect();

            const query = 'DELETE FROM documents WHERE id = $1 RETURNING *';
            const result = await client.query(query, [id]);
            return result.rows[0];
        } catch (error) {
            console.error('Error deleting document:', error);
            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // Get documents by source template (for push-to-all)
    async getBySourceTemplateId(template_document_id) {
        let client;
        try {
            client = await this.pool.connect();
            const q = `
                SELECT * FROM documents
                WHERE source_template_document_id = $1 AND entity_type = 'organization'
            `;
            const r = await client.query(q, [template_document_id]);
            return r.rows;
        } finally {
            if (client) client.release();
        }
    }

    // Get all organization Welcome documents (for push when using direct file upload)
    async getOrganizationWelcomeDocuments() {
        let client;
        try {
            client = await this.pool.connect();
            const q = `
                SELECT * FROM documents
                WHERE entity_type = 'organization' AND document_type = 'Welcome'
            `;
            const r = await client.query(q, []);
            return r.rows;
        } finally {
            if (client) client.release();
        }
    }

    // Create default welcome document for organization
    async createDefaultOrganizationDocument(organization_id, organization_name, created_by) {
        const welcomeContent = `
WELCOME DOCUMENT
================

Organization: ${organization_name}
Date: ${new Date().toLocaleDateString()}

Dear Team,

This is an auto-generated welcome document for ${organization_name}.

This document serves as a placeholder and can be updated with:
- Standard service agreements
- Contract templates
- Terms and conditions
- Company policies
- Partnership agreements

Please update this document with relevant information for this organization.

---
Auto-generated on organization creation
        `.trim();

        return await this.create({
            entity_type: 'organization',
            entity_id: organization_id,
            document_name: 'Welcome Document',
            document_type: 'Welcome',
            mime_type: 'text/plain',
            is_auto_generated: true,
            content: welcomeContent,
            created_by: created_by
        });
    }
}

module.exports = Document;

