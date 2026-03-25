// models/unarchiveRequest.js
let unarchiveRequestTableInitialized = false;

class UnarchiveRequest {
  constructor(pool) {
    this.pool = pool;
  }

  async initTable() {
    if (unarchiveRequestTableInitialized) return;
    const client = await this.pool.connect();
    try {
      console.log("Initializing unarchive_requests table...");
      await client.query(`
        CREATE TABLE IF NOT EXISTS unarchive_requests (
          id SERIAL PRIMARY KEY,
          record_id INTEGER NOT NULL,
          record_type VARCHAR(50) NOT NULL,
          record_number VARCHAR(50),
          requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          requested_by_name VARCHAR(255),
          requested_by_email VARCHAR(255),
          reason TEXT NOT NULL,
          status VARCHAR(50) DEFAULT 'pending',
          denial_reason TEXT,
          reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          reviewed_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_unarchive_requests_record
        ON unarchive_requests(record_id, record_type)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_unarchive_requests_status
        ON unarchive_requests(status)
      `);
      console.log("✅ unarchive_requests table initialized");
      unarchiveRequestTableInitialized = true;
    } catch (error) {
      console.error("❌ Error initializing unarchive_requests table:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  async create(data) {
    await this.initTable();
    const client = await this.pool.connect();
    try {
      const {
        record_id,
        record_type,
        record_number,
        requested_by,
        requested_by_name,
        requested_by_email,
        reason,
      } = data;

      const result = await client.query(
        `
        INSERT INTO unarchive_requests (
          record_id,
          record_type,
          record_number,
          requested_by,
          requested_by_name,
          requested_by_email,
          reason,
          status,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', (NOW() AT TIME ZONE 'UTC'), (NOW() AT TIME ZONE 'UTC'))
        RETURNING *
      `,
        [
          record_id,
          record_type,
          record_number || null,
          requested_by || null,
          requested_by_name || null,
          requested_by_email || null,
          reason,
        ]
      );
      return result.rows[0];
    } finally {
      client.release();
    }
  }

  async getById(id) {
    await this.initTable();
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `
        SELECT ur.*,
               u.name as reviewed_by_name
        FROM unarchive_requests ur
        LEFT JOIN users u ON ur.reviewed_by = u.id
        WHERE ur.id = $1
      `,
        [id]
      );
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }

  async approve(id, reviewedBy) {
    await this.initTable();
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `
        UPDATE unarchive_requests
        SET status = 'approved',
            reviewed_by = $1,
            reviewed_at = (NOW() AT TIME ZONE 'UTC'),
            updated_at = (NOW() AT TIME ZONE 'UTC')
        WHERE id = $2 AND status = 'pending'
        RETURNING *
      `,
        [reviewedBy, id]
      );
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }

  async deny(id, denialReason, reviewedBy) {
    await this.initTable();
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `
        UPDATE unarchive_requests
        SET status = 'denied',
            denial_reason = $1,
            reviewed_by = $2,
            reviewed_at = (NOW() AT TIME ZONE 'UTC'),
            updated_at = (NOW() AT TIME ZONE 'UTC')
        WHERE id = $3 AND status = 'pending'
        RETURNING *
      `,
        [denialReason, reviewedBy, id]
      );
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }
}

module.exports = UnarchiveRequest;
