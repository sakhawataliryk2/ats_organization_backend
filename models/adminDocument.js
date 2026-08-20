// models/adminDocument.js
class AdminDocument {
  constructor(pool) {
    this.pool = pool;
  }

  async initTable() {
    let client;
    try {
      console.log("Initializing admin_documents table if needed...");
      client = await this.pool.connect();

      await client.query(`
        CREATE TABLE IF NOT EXISTS admin_documents (
          id SERIAL PRIMARY KEY,
          document_name VARCHAR(255) NOT NULL,
          category VARCHAR(100) NOT NULL,
          content TEXT,
          file_path TEXT,
          file_size INTEGER,
          mime_type VARCHAR(100),
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_admin_documents_category 
        ON admin_documents(category)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_admin_documents_created_at 
        ON admin_documents(created_at DESC)
      `);

      console.log("✅ Admin documents table initialized successfully");
      return true;
    } catch (error) {
      console.error("❌ Error initializing admin_documents table:", error.message);
      throw error;
    } finally {
      if (client) client.release();
    }
  }

  async create(data) {
    const {
      document_name,
      category,
      content = null,
      file_path = null,
      file_size = null,
      mime_type = "text/plain",
      created_by = null,
    } = data;

    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `
        INSERT INTO admin_documents (
          document_name, category, content, file_path, file_size, mime_type, created_by, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING *
        `,
        [document_name, category, content, file_path, file_size, mime_type, created_by]
      );
      return result.rows[0];
    } catch (error) {
      console.error("Error creating admin document:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  async getAll(filters = {}) {
    const { search = "", category = "", page = 1, limit = 250, sortBy = "document_name", sortOrder = "ASC" } = filters;
    const client = await this.pool.connect();
    try {
      let query = `
        SELECT d.*, u.name as created_by_name
        FROM admin_documents d
        LEFT JOIN users u ON d.created_by = u.id
        WHERE 1=1
      `;
      const params = [];
      let paramCount = 1;

      if (search) {
        query += ` AND d.document_name ILIKE $${paramCount}`;
        params.push(`%${search}%`);
        paramCount++;
      }

      if (category) {
        query += ` AND d.category = $${paramCount}`;
        params.push(category);
        paramCount++;
      }

      // Validate sortBy to prevent SQL injection
      const allowedSortFields = ["document_name", "category", "created_at"];
      const safeSortBy = allowedSortFields.includes(sortBy) ? sortBy : "document_name";
      const safeSortOrder = sortOrder.toUpperCase() === "DESC" ? "DESC" : "ASC";

      query += ` ORDER BY d.${safeSortBy} ${safeSortOrder}`;

      // Get total count
      const countQuery = query.replace(
        /SELECT d\.\*, u\.name as created_by_name FROM admin_documents d LEFT JOIN users u ON d\.created_by = u\.id WHERE 1=1.*ORDER BY.*/,
        "SELECT COUNT(*) FROM admin_documents d WHERE 1=1"
      );
      const countParams = params.slice(0, params.length - (category ? 1 : 0) - (search ? 1 : 0));
      const countResult = await client.query(countQuery, countParams);
      const total = parseInt(countResult.rows[0].count);

      // Apply pagination
      const offset = (page - 1) * limit;
      query += ` LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
      params.push(limit, offset);

      const result = await client.query(query, params);
      return {
        documents: result.rows,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      };
    } catch (error) {
      console.error("Error fetching admin documents:", error);
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
        SELECT d.*, u.name as created_by_name
        FROM admin_documents d
        LEFT JOIN users u ON d.created_by = u.id
        WHERE d.id = $1
        `,
        [id]
      );
      return result.rows[0] || null;
    } catch (error) {
      console.error("Error fetching admin document:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  async update(id, data) {
    const { document_name, category, content, file_path, file_size, mime_type } = data;
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `
        UPDATE admin_documents
        SET document_name = COALESCE($1, document_name),
            category = COALESCE($2, category),
            content = COALESCE($3, content),
            file_path = COALESCE($4, file_path),
            file_size = COALESCE($5, file_size),
            mime_type = COALESCE($6, mime_type),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $7
        RETURNING *
        `,
        [document_name, category, content, file_path, file_size, mime_type, id]
      );
      return result.rows[0];
    } catch (error) {
      console.error("Error updating admin document:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  async delete(id) {
    const client = await this.pool.connect();
    try {
      const result = await client.query("DELETE FROM admin_documents WHERE id = $1 RETURNING *", [id]);
      return result.rows[0];
    } catch (error) {
      console.error("Error deleting admin document:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  async getCategories() {
    const client = await this.pool.connect();
    try {
      const result = await client.query(`
        SELECT DISTINCT category 
        FROM admin_documents 
        ORDER BY category ASC
      `);
      return result.rows.map((row) => row.category);
    } catch (error) {
      console.error("Error fetching categories:", error);
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = AdminDocument;

