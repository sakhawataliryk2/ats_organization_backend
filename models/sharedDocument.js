// models/sharedDocument.js
class SharedDocument {
  constructor(pool) {
    this.pool = pool;
  }

  async initTable() {
    let client;
    try {
      console.log("Initializing shared_documents table if needed...");
      client = await this.pool.connect();

      await client.query(`
        CREATE TABLE IF NOT EXISTS shared_documents (
          id SERIAL PRIMARY KEY,
          file_name VARCHAR(255) NOT NULL,
          file_path TEXT NOT NULL,
          file_size INTEGER,
          mime_type VARCHAR(100),
          description TEXT,
          uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_shared_documents_created_at 
        ON shared_documents(created_at DESC)
      `);

      console.log("✅ Shared documents table initialized successfully");
      return true;
    } catch (error) {
      console.error("❌ Error initializing shared_documents table:", error.message);
      throw error;
    } finally {
      if (client) client.release();
    }
  }

  async create(data) {
    const {
      file_name,
      file_path,
      file_size = null,
      mime_type = null,
      description = null,
      uploaded_by = null,
    } = data;

    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `
        INSERT INTO shared_documents (
          file_name, file_path, file_size, mime_type, description, uploaded_by, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING *
        `,
        [file_name, file_path, file_size, mime_type, description, uploaded_by]
      );
      return result.rows[0];
    } catch (error) {
      console.error("Error creating shared document:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  async getAll() {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `
        SELECT 
          d.*,
          u.name AS uploaded_by_name
        FROM shared_documents d
        LEFT JOIN users u ON d.uploaded_by = u.id
        ORDER BY d.created_at DESC
        `
      );
      return result.rows;
    } catch (error) {
      console.error("Error fetching shared documents:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  async getById(id) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `
        SELECT 
          d.*,
          u.name AS uploaded_by_name
        FROM shared_documents d
        LEFT JOIN users u ON d.uploaded_by = u.id
        WHERE d.id = $1
        `,
        [id]
      );
      return result.rows[0] || null;
    } catch (error) {
      console.error("Error fetching shared document:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  async delete(id) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        "DELETE FROM shared_documents WHERE id = $1 RETURNING *",
        [id]
      );
      return result.rows[0];
    } catch (error) {
      console.error("Error deleting shared document:", error);
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = SharedDocument;

