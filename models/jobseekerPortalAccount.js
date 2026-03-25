// models/jobseekerPortalAccount.js
const bcrypt = require("bcryptjs");

class JobseekerPortalAccount {
  constructor(pool) {
    this.pool = pool;
  }

  async initTable() {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS job_seeker_portal_accounts (
          id SERIAL PRIMARY KEY,
          job_seeker_id INTEGER NOT NULL UNIQUE REFERENCES job_seekers(id) ON DELETE CASCADE,
          email VARCHAR(255) NOT NULL,
          password_hash TEXT NOT NULL,
          must_reset_password BOOLEAN NOT NULL DEFAULT TRUE,
          created_by INTEGER REFERENCES users(id),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // safe migration (if table already existed)
      await client.query(`
        ALTER TABLE job_seeker_portal_accounts
        ADD COLUMN IF NOT EXISTS must_reset_password BOOLEAN NOT NULL DEFAULT true
      `);
    } finally {
      client.release();
    }
  }

  async findByEmail(email) {
    const q = `
      SELECT id, job_seeker_id, email, password_hash, must_reset_password
      FROM job_seeker_portal_accounts
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
    `;
    const { rows } = await this.pool.query(q, [email]);
    return rows[0] || null;
  }

  async findByJobSeekerId(job_seeker_id) {
    const q = `
      SELECT id, job_seeker_id, email, must_reset_password
      FROM job_seeker_portal_accounts
      WHERE job_seeker_id = $1
      LIMIT 1
    `;
    const { rows } = await this.pool.query(q, [job_seeker_id]);
    return rows[0] || null;
  }

  async create({ job_seeker_id, email, tempPassword, created_by }) {
    const password_hash = await bcrypt.hash(tempPassword, 10);

    const q = `
      INSERT INTO job_seeker_portal_accounts
        (job_seeker_id, email, password_hash, must_reset_password, created_by)
      VALUES
        ($1, $2, $3, TRUE, $4)
      RETURNING id, job_seeker_id, email, must_reset_password
    `;

    const { rows } = await this.pool.query(q, [
      job_seeker_id,
      email,
      password_hash,
      created_by || null,
    ]);

    return rows[0];
  }

  async setPassword({ job_seeker_id, newPassword, must_reset_password }) {
    const password_hash = await bcrypt.hash(newPassword, 10);

    const q = `
      UPDATE job_seeker_portal_accounts
      SET password_hash=$1,
          must_reset_password=$2,
          updated_at=CURRENT_TIMESTAMP
      WHERE job_seeker_id=$3
      RETURNING id, job_seeker_id, email, must_reset_password
    `;

    const { rows } = await this.pool.query(q, [
      password_hash,
      !!must_reset_password,
      job_seeker_id,
    ]);

    return rows[0] || null;
  }

  async verifyPassword(accountRow, password) {
    return bcrypt.compare(password, accountRow.password_hash);
  }
}

module.exports = JobseekerPortalAccount;
