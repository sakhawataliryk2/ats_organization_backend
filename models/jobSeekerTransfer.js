// models/jobSeekerTransfer.js
class JobSeekerTransfer {
  constructor(pool) {
    this.pool = pool;
  }

  async initTable() {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS job_seeker_transfers (
          id SERIAL PRIMARY KEY,
          source_job_seeker_id INTEGER NOT NULL REFERENCES job_seekers(id) ON DELETE CASCADE,
          target_job_seeker_id INTEGER NOT NULL REFERENCES job_seekers(id) ON DELETE CASCADE,
          requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          requested_by_name VARCHAR(255),
          requested_by_email VARCHAR(255),
          source_record_number VARCHAR(50),
          target_record_number VARCHAR(50),
          status VARCHAR(50) DEFAULT 'pending',
          denial_reason TEXT,
          approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          approved_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT chk_js_transfer_different CHECK (source_job_seeker_id != target_job_seeker_id)
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_js_transfers_source ON job_seeker_transfers(source_job_seeker_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_js_transfers_target ON job_seeker_transfers(target_job_seeker_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_js_transfers_status ON job_seeker_transfers(status)
      `);
    } finally {
      client.release();
    }
  }

  async create(data) {
    const client = await this.pool.connect();
    try {
      const {
        source_job_seeker_id,
        target_job_seeker_id,
        requested_by,
        requested_by_name,
        requested_by_email,
        source_record_number,
        target_record_number,
      } = data;

      const result = await client.query(
        `
        INSERT INTO job_seeker_transfers (
          source_job_seeker_id,
          target_job_seeker_id,
          requested_by,
          requested_by_name,
          requested_by_email,
          source_record_number,
          target_record_number,
          status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
        RETURNING *
      `,
        [
          source_job_seeker_id,
          target_job_seeker_id,
          requested_by || null,
          requested_by_name || null,
          requested_by_email || null,
          source_record_number || null,
          target_record_number || null,
        ]
      );
      return result.rows[0];
    } finally {
      client.release();
    }
  }

  async getById(id) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `
        SELECT t.*,
               CONCAT(sjs.last_name, ', ', sjs.first_name) as source_js_name,
               CONCAT(tjs.last_name, ', ', tjs.first_name) as target_js_name
        FROM job_seeker_transfers t
        LEFT JOIN job_seekers sjs ON t.source_job_seeker_id = sjs.id
        LEFT JOIN job_seekers tjs ON t.target_job_seeker_id = tjs.id
        WHERE t.id = $1
      `,
        [id]
      );
      return result.rows[0];
    } finally {
      client.release();
    }
  }

  async approve(id, approvedBy) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `
        UPDATE job_seeker_transfers
        SET status = 'approved',
            approved_by = $1,
            approved_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $2 AND status = 'pending'
        RETURNING *
      `,
        [approvedBy, id]
      );
      if (result.rows.length === 0) {
        await client.query("ROLLBACK");
        throw new Error("Transfer request not found or already processed");
      }
      await client.query("COMMIT");
      return result.rows[0];
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async deny(id, denialReason, deniedBy) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `
        UPDATE job_seeker_transfers
        SET status = 'denied',
            denial_reason = $1,
            approved_by = $2,
            approved_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $3 AND status = 'pending'
        RETURNING *
      `,
        [denialReason, deniedBy, id]
      );
      if (result.rows.length === 0) {
        await client.query("ROLLBACK");
        throw new Error("Transfer request not found or already processed");
      }
      await client.query("COMMIT");
      return result.rows[0];
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = JobSeekerTransfer;
