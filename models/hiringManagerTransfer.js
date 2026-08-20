// models/hiringManagerTransfer.js
class HiringManagerTransfer {
  constructor(pool) {
    this.pool = pool;
  }

  async initTable() {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS hiring_manager_transfers (
          id SERIAL PRIMARY KEY,
          source_hiring_manager_id INTEGER NOT NULL REFERENCES hiring_managers(id) ON DELETE CASCADE,
          target_hiring_manager_id INTEGER NOT NULL REFERENCES hiring_managers(id) ON DELETE CASCADE,
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
          CONSTRAINT chk_hm_transfer_different CHECK (source_hiring_manager_id != target_hiring_manager_id)
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_hm_transfers_source ON hiring_manager_transfers(source_hiring_manager_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_hm_transfers_target ON hiring_manager_transfers(target_hiring_manager_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_hm_transfers_status ON hiring_manager_transfers(status)
      `);
    } finally {
      client.release();
    }
  }

  async create(data) {
    const client = await this.pool.connect();
    try {
      const {
        source_hiring_manager_id,
        target_hiring_manager_id,
        requested_by,
        requested_by_name,
        requested_by_email,
        source_record_number,
        target_record_number,
      } = data;

      const result = await client.query(
        `
        INSERT INTO hiring_manager_transfers (
          source_hiring_manager_id,
          target_hiring_manager_id,
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
          source_hiring_manager_id,
          target_hiring_manager_id,
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
               CONCAT(shm.last_name, ', ', shm.first_name) as source_hm_name,
               shm.organization_id as source_organization_id,
               CONCAT(thm.last_name, ', ', thm.first_name) as target_hm_name,
               thm.organization_id as target_organization_id
        FROM hiring_manager_transfers t
        LEFT JOIN hiring_managers shm ON t.source_hiring_manager_id = shm.id
        LEFT JOIN hiring_managers thm ON t.target_hiring_manager_id = thm.id
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
        UPDATE hiring_manager_transfers
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
        UPDATE hiring_manager_transfers
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

module.exports = HiringManagerTransfer;
