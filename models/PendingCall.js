/**
 * PendingCall model - tracks click-to-call sessions for matching with Zoom CDR webhooks.
 * Table: pending_calls (candidate_id = job_seeker id)
 */

let pendingCallsTableInitialized = false;

class PendingCall {
  constructor(pool) {
    this.pool = pool;
  }

  async initTable() {
    if (pendingCallsTableInitialized) return;
    let client;
    try {
      client = await this.pool.connect();
      await client.query(`
        CREATE TABLE IF NOT EXISTS pending_calls (
          id SERIAL PRIMARY KEY,
          candidate_id INTEGER NOT NULL REFERENCES job_seekers(id) ON DELETE CASCADE,
          phone_number VARCHAR(50) NOT NULL,
          target_e164 VARCHAR(50),
          target_ext VARCHAR(20),
          recruiter_user_id INTEGER REFERENCES users(id),
          status VARCHAR(50) NOT NULL DEFAULT 'initiated',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      // Backfill schema for older deployments where the columns don't exist yet
      await client.query(`ALTER TABLE pending_calls ADD COLUMN IF NOT EXISTS target_e164 VARCHAR(50)`);
      await client.query(`ALTER TABLE pending_calls ADD COLUMN IF NOT EXISTS target_ext VARCHAR(20)`);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_pending_calls_phone_number ON pending_calls(phone_number)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_pending_calls_target_e164 ON pending_calls(target_e164)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_pending_calls_target_ext ON pending_calls(target_ext)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_pending_calls_created_at ON pending_calls(created_at DESC)
      `);
      pendingCallsTableInitialized = true;
      console.log('✅ pending_calls table initialized');
    } catch (error) {
      console.error('Error initializing pending_calls table:', error);
      throw error;
    } finally {
      if (client) client.release();
    }
  }

  /**
   * Create a pending call record (click-to-call initiated).
   * @param {object} data - { candidateId, phoneNumber, recruiterUserId, targetE164, targetExt }
   * @returns {Promise<object>} inserted row
   */
  async create(data) {
    const client = await this.pool.connect();
    try {
      await this.initTable();
      const result = await client.query(
        `INSERT INTO pending_calls (candidate_id, phone_number, target_e164, target_ext, recruiter_user_id, status)
         VALUES ($1, $2, $3, $4, $5, 'initiated')
         RETURNING *`,
        [
          data.candidateId,
          data.phoneNumber,
          data.targetE164 || null,
          data.targetExt || null,
          data.recruiterUserId || null,
        ]
      );
      return result.rows[0];
    } finally {
      client.release();
    }
  }

  /**
   * Find most recent pending call by callee phone number (normalized).
   * @param {string} phoneNumber - normalized phone number (e.g. +15551234567)
   * @returns {Promise<object|null>} pending call row or null
   */
  async findLatestByPhoneNumber(phoneNumber) {
    if (!phoneNumber) return null;
    const client = await this.pool.connect();
    try {
      const digits = String(phoneNumber).replace(/[^\d]/g, "");
      const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
      if (!last10) return null;

      const result = await client.query(
        `SELECT * FROM pending_calls
         WHERE status = 'initiated'
           AND RIGHT(regexp_replace(COALESCE(phone_number, ''), '\\D', '', 'g'), 10) = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [last10]
      );
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }

  /**
   * Find most recent pending call by recruiter user id within a recent time window.
   * This is used when Zoom's reported callee number does not exactly match the
   * candidate's stored number due to forwarding/routing, but the recruiter who
   * initiated the click-to-call is known.
   *
   * @param {number} recruiterUserId
   * @param {number} lookbackMinutes - how far back to search
   * @returns {Promise<object|null>}
   */
  async findLatestByRecruiterUserId(recruiterUserId, lookbackMinutes = 15) {
    if (!recruiterUserId) return null;
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT *
         FROM pending_calls
         WHERE status = 'initiated'
           AND recruiter_user_id = $1
           AND created_at >= NOW() - ($2::int || ' minutes')::interval
         ORDER BY created_at DESC
         LIMIT 1`,
        [recruiterUserId, lookbackMinutes],
      );
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }

  /**
   * Find most recent pending call for a recruiter, optionally matching target by E.164/ext.
   * This is most useful for internal calls where Zoom webhooks only provide extensions.
   *
   * @param {number} recruiterUserId
   * @param {object} match - { targetE164, targetExt }
   * @param {number} lookbackMinutes
   * @returns {Promise<object|null>}
   */
  async findLatestByRecruiterAndTarget(
    recruiterUserId,
    match = {},
    lookbackMinutes = 15,
  ) {
    if (!recruiterUserId) return null;
    const targetE164 = match?.targetE164 || null;
    const targetExt = match?.targetExt || null;

    const client = await this.pool.connect();
    try {
      const clauses = [];
      const values = [recruiterUserId, lookbackMinutes];
      let idx = values.length;

      if (targetE164) {
        values.push(targetE164);
        idx += 1;
        clauses.push(`target_e164 = $${idx}`);
      }
      if (targetExt) {
        values.push(targetExt);
        idx += 1;
        clauses.push(`target_ext = $${idx}`);
      }

      const targetClause =
        clauses.length > 0 ? `AND (${clauses.join(" OR ")})` : "";

      const result = await client.query(
        `SELECT *
         FROM pending_calls
         WHERE status = 'initiated'
           AND recruiter_user_id = $1
           AND created_at >= NOW() - ($2::int || ' minutes')::interval
           ${targetClause}
         ORDER BY created_at DESC
         LIMIT 1`,
        values,
      );
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }

  /**
   * Mark a pending call as completed.
   * @param {number} id - pending_calls.id
   */
  async markCompleted(id) {
    const client = await this.pool.connect();
    try {
      await client.query(
        `UPDATE pending_calls SET status = 'completed' WHERE id = $1`,
        [id]
      );
    } finally {
      client.release();
    }
  }
}

module.exports = PendingCall;
