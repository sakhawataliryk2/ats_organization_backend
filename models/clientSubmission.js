/**
 * Client Submissions - dedicated table separate from job_seeker_applications.
 * Stores richer metadata for client-facing submissions.
 */
class ClientSubmission {
  constructor(pool) {
    this.pool = pool;
  }

  async initTable() {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS client_submissions (
          id SERIAL PRIMARY KEY,
          job_seeker_id INTEGER NOT NULL REFERENCES job_seekers(id) ON DELETE CASCADE,
          job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          job_title VARCHAR(500),
          organization_id INTEGER,
          organization_name VARCHAR(500),
          status VARCHAR(100) DEFAULT '',
          submission_source VARCHAR(255) DEFAULT '',
          comments TEXT,
          comments_html TEXT,
          attachment_ids TEXT,
          hiring_manager_ids TEXT,
          internal_email_notification TEXT,
          submitted_by_name VARCHAR(255),
          submitted_by_email VARCHAR(255),
          send_email BOOLEAN DEFAULT FALSE,
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_client_submissions_job_seeker_id
        ON client_submissions(job_seeker_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_client_submissions_job_id
        ON client_submissions(job_id)
      `);
    } finally {
      client.release();
    }
  }

  async getByJobSeekerId(jobSeekerId, userId = null) {
    const client = await this.pool.connect();
    try {
      const params = [jobSeekerId];
      const whereUser =
        userId != null
          ? " AND created_by = $2"
          : "";
      const result = await client.query(
        `
        SELECT *
        FROM client_submissions
        WHERE job_seeker_id = $1
        ${whereUser}
        ORDER BY created_at DESC
        `,
        userId != null ? [...params, userId] : params
      );
      return result.rows;
    } finally {
      client.release();
    }
  }

  async getByJobId(jobId) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `
        SELECT *
        FROM client_submissions
        WHERE job_id = $1
        ORDER BY created_at DESC
        `,
        [jobId]
      );
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * Check if a client submission already exists for a given job seeker + job pair.
   */
  async existsForJobSeekerAndJob(jobSeekerId, jobId) {
    if (!jobSeekerId || !jobId) return false;
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `
        SELECT 1
        FROM client_submissions
        WHERE job_seeker_id = $1
          AND job_id = $2
        LIMIT 1
        `,
        [jobSeekerId, jobId]
      );
      return result.rowCount > 0;
    } finally {
      client.release();
    }
  }

  async create(data) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `
        INSERT INTO client_submissions (
          job_seeker_id,
          job_id,
          job_title,
          organization_id,
          organization_name,
          status,
          submission_source,
          comments,
          comments_html,
          attachment_ids,
          hiring_manager_ids,
          internal_email_notification,
          submitted_by_name,
          submitted_by_email,
          send_email,
          created_by
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16
        )
        RETURNING *
        `,
        [
          data.job_seeker_id,
          data.job_id,
          data.job_title || "",
          data.organization_id || null,
          data.organization_name || "",
          data.status || "",
          data.submission_source || "",
          data.comments || "",
          data.comments_html || "",
          Array.isArray(data.attachment_ids)
            ? data.attachment_ids.join(",")
            : data.attachment_ids || "",
          Array.isArray(data.hiring_manager_ids)
            ? data.hiring_manager_ids.join(",")
            : data.hiring_manager_ids || "",
          Array.isArray(data.internal_email_notification)
            ? data.internal_email_notification.join(",")
            : data.internal_email_notification || "",
          data.submitted_by_name || "",
          data.submitted_by_email || "",
          !!data.send_email,
          data.created_by || null,
        ]
      );
      return result.rows[0];
    } finally {
      client.release();
    }
  }
}

module.exports = ClientSubmission;

