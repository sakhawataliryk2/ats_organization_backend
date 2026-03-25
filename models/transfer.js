// models/transfer.js
class Transfer {
  constructor(pool) {
    this.pool = pool;
  }

  async initTable() {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS organization_transfers (
          id SERIAL PRIMARY KEY,
          source_organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
          target_organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
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
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create scheduled_tasks table for cleanup jobs
      await client.query(`
        CREATE TABLE IF NOT EXISTS scheduled_tasks (
          id SERIAL PRIMARY KEY,
          task_type VARCHAR(100) NOT NULL,
          task_data JSONB,
          scheduled_for TIMESTAMP NOT NULL,
          status VARCHAR(50) DEFAULT 'pending',
          completed_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create index for faster lookups
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_transfers_source_org ON organization_transfers(source_organization_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_transfers_target_org ON organization_transfers(target_organization_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_transfers_status ON organization_transfers(status)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status ON scheduled_tasks(status, scheduled_for)
      `);
    } finally {
      client.release();
    }
  }

  async create(transferData) {
    const client = await this.pool.connect();
    try {
      const {
        source_organization_id,
        target_organization_id,
        requested_by,
        requested_by_name,
        requested_by_email,
        source_record_number,
        target_record_number,
      } = transferData;

      const result = await client.query(
        `
        INSERT INTO organization_transfers (
          source_organization_id,
          target_organization_id,
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
          source_organization_id,
          target_organization_id,
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
               so.name as source_organization_name,
               to_org.name as target_organization_name
        FROM organization_transfers t
        LEFT JOIN organizations so ON t.source_organization_id = so.id
        LEFT JOIN organizations to_org ON t.target_organization_id = to_org.id
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
        UPDATE organization_transfers
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
        UPDATE organization_transfers
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

  async getPendingTransfers() {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `
        SELECT t.*,
               so.name as source_organization_name,
               to_org.name as target_organization_name
        FROM organization_transfers t
        LEFT JOIN organizations so ON t.source_organization_id = so.id
        LEFT JOIN organizations to_org ON t.target_organization_id = to_org.id
        WHERE t.status = 'pending'
        ORDER BY t.created_at DESC
      `
      );

      return result.rows;
    } finally {
      client.release();
    }
  }
}

module.exports = Transfer;
