/**
 * Job Seeker Applications - separate table for submissions (client_submissions, web_submissions, submissions).
 * Replaces storing applications in job_seekers.custom_fields.applications for scalability and reliable fetch.
 */
class JobSeekerApplication {
  constructor(pool) {
    this.pool = pool;
  }

  async initTable() {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS job_seeker_applications (
          id SERIAL PRIMARY KEY,
          job_seeker_id INTEGER NOT NULL REFERENCES job_seekers(id) ON DELETE CASCADE,
          type VARCHAR(50) NOT NULL,
          job_id INTEGER,
          job_title VARCHAR(500),
          organization_id INTEGER,
          organization_name VARCHAR(500),
          client_id INTEGER,
          client_name VARCHAR(500),
          status VARCHAR(100) DEFAULT '',
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          notes TEXT,
          submission_source VARCHAR(255) DEFAULT ''
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_job_seeker_applications_job_seeker_id
        ON job_seeker_applications(job_seeker_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_job_seeker_applications_type
        ON job_seeker_applications(type)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_job_seeker_applications_job_id
        ON job_seeker_applications(job_id)
      `);
    } finally {
      client.release();
    }
  }

  /**
   * Get all applications for the Kanban board (optionally scoped by user).
   * Returns raw rows with id, job_seeker_id, job_id, job_title, organization_name, status, etc.
   */
  async getAllForBoard(userId = null) {
    const client = await this.pool.connect();
    try {
      let query = `
        SELECT a.id, a.job_seeker_id, a.job_id, a.job_title, a.organization_name, a.client_name, a.status, a.created_at
        FROM job_seeker_applications a
        INNER JOIN job_seekers js ON js.id = a.job_seeker_id
        WHERE js.archived_at IS NULL
      `;
      const params = [];
      if (userId != null) {
        params.push(userId);
        query += ` AND js.created_by = $${params.length}`;
      }
      query += ` ORDER BY a.created_at DESC`;
      const result = await client.query(query, params);
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * Get one application by id and job_seeker_id.
   */
  async getById(applicationId, jobSeekerId) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        "SELECT * FROM job_seeker_applications WHERE id = $1 AND job_seeker_id = $2",
        [applicationId, jobSeekerId]
      );
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }

  /**
   * Get all applications for a job seeker, ordered by created_at desc.
   * Returns rows with created_by_name when joined to users.
   * If userId is provided, results are scoped to applications created by that user.
   */
  async getByJobSeekerId(jobSeekerId, userId = null) {
    const client = await this.pool.connect();
    try {
      const params = [jobSeekerId];
      const whereUser =
        userId != null
          ? " AND a.created_by = $2"
          : "";
      const result = await client.query(
        `
        SELECT a.*, u.name AS created_by_name
        FROM job_seeker_applications a
        LEFT JOIN users u ON a.created_by = u.id
        WHERE a.job_seeker_id = $1
        ${whereUser}
        ORDER BY a.created_at DESC
        `,
        userId != null ? [...params, userId] : params
      );
      return result.rows.map((row) => ({
        id: row.id,
        type: row.type,
        job_id: row.job_id,
        job_title: row.job_title,
        organization_id: row.organization_id,
        organization_name: row.organization_name,
        client_id: row.client_id,
        client_name: row.client_name,
        status: row.status,
        created_by: row.created_by,
        created_by_name: row.created_by_name,
        created_at: row.created_at,
        notes: row.notes,
        submission_source: row.submission_source,
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Check if an application already exists for a given job seeker + job pair,
   * regardless of application type.
   */
  async existsForJobSeekerAndJob(jobSeekerId, jobId) {
    if (!jobSeekerId || !jobId) return false;
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `
        SELECT 1
        FROM job_seeker_applications
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

  /**
   * Get all applications for a job (across all job seekers), ordered by created_at desc.
   * Useful for populating the "Applied" tab on the Job record.
   */
  async getByJobId(jobId) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `
        SELECT a.*, u.name AS created_by_name
        FROM job_seeker_applications a
        LEFT JOIN users u ON a.created_by = u.id
        WHERE a.job_id = $1
        ORDER BY a.created_at DESC
        `,
        [jobId]
      );
      return result.rows.map((row) => ({
        id: row.id,
        job_seeker_id: row.job_seeker_id,
        type: row.type,
        job_id: row.job_id,
        job_title: row.job_title,
        organization_id: row.organization_id,
        organization_name: row.organization_name,
        client_id: row.client_id,
        client_name: row.client_name,
        status: row.status,
        created_by: row.created_by,
        created_by_name: row.created_by_name,
        created_at: row.created_at,
        notes: row.notes,
        submission_source: row.submission_source,
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Create a new application. Returns the created row.
   */
  async create(data) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `
        INSERT INTO job_seeker_applications (
          job_seeker_id, type, job_id, job_title,
          organization_id, organization_name, client_id, client_name,
          status, created_by, notes, submission_source
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *
        `,
        [
          data.job_seeker_id,
          data.type,
          data.job_id || null,
          data.job_title || "",
          data.organization_id || null,
          data.organization_name || "",
          data.client_id || null,
          data.client_name || "",
          data.status || "",
          data.created_by || null,
          data.notes || "",
          data.submission_source || "",
        ]
      );
      const row = result.rows[0];
      return {
        id: row.id,
        type: row.type,
        job_id: row.job_id,
        job_title: row.job_title,
        organization_id: row.organization_id,
        organization_name: row.organization_name,
        client_id: row.client_id,
        client_name: row.client_name,
        status: row.status,
        created_by: row.created_by,
        created_at: row.created_at,
        notes: row.notes,
        submission_source: row.submission_source,
      };
    } finally {
      client.release();
    }
  }

  /**
   * Update application (e.g. status for "Schedule Interview").
   * Returns updated row or null if not found.
   */
  async update(applicationId, jobSeekerId, updates) {
    const client = await this.pool.connect();
    try {
      const allowed = ["status", "notes"];
      const setClauses = [];
      const values = [];
      let i = 1;
      for (const key of allowed) {
        if (updates[key] !== undefined) {
          setClauses.push(`${key} = $${i}`);
          values.push(updates[key]);
          i++;
        }
      }
      if (setClauses.length === 0) {
        const r = await client.query(
          "SELECT * FROM job_seeker_applications WHERE id = $1 AND job_seeker_id = $2",
          [applicationId, jobSeekerId]
        );
        return r.rows[0] || null;
      }
      values.push(applicationId, jobSeekerId);
      const result = await client.query(
        `
        UPDATE job_seeker_applications
        SET ${setClauses.join(", ")}
        WHERE id = $${i} AND job_seeker_id = $${i + 1}
        RETURNING *
        `,
        values
      );
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }
}

module.exports = JobSeekerApplication;
