// models/timecard.js
// Timecards for job seekers: weekly hours per placement (draft → submitted → approved)

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const STATUSES = ["draft", "submitted", "approved"];
const MAX_HOURS_PER_DAY = 24;
const MAX_DECIMAL = 2;

function toDateOnly(d) {
  if (!d) return null;
  if (typeof d === "string" && d.match(/^\d{4}-\d{2}-\d{2}/)) return d.slice(0, 10);
  const date = new Date(d);
  if (isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/** Returns true if date is a Monday (week_start for timecards). */
function isMonday(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  return d.getUTCDay() === 1;
}

class Timecard {
  constructor(pool) {
    this.pool = pool;
  }

  async initTable() {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS timecards (
          id SERIAL PRIMARY KEY,
          job_seeker_id INTEGER NOT NULL REFERENCES job_seekers(id) ON DELETE CASCADE,
          placement_id INTEGER NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
          week_start_date DATE NOT NULL,
          mon NUMERIC(5,2) NOT NULL DEFAULT 0,
          tue NUMERIC(5,2) NOT NULL DEFAULT 0,
          wed NUMERIC(5,2) NOT NULL DEFAULT 0,
          thu NUMERIC(5,2) NOT NULL DEFAULT 0,
          fri NUMERIC(5,2) NOT NULL DEFAULT 0,
          sat NUMERIC(5,2) NOT NULL DEFAULT 0,
          sun NUMERIC(5,2) NOT NULL DEFAULT 0,
          total_hours NUMERIC(6,2) NOT NULL DEFAULT 0,
          status VARCHAR(20) NOT NULL DEFAULT 'draft',
          submitted_at TIMESTAMP,
          approved_at TIMESTAMP,
          approved_by INTEGER REFERENCES users(id),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(placement_id, week_start_date)
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_timecards_job_seeker_id ON timecards(job_seeker_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_timecards_placement_id ON timecards(placement_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_timecards_week_start ON timecards(week_start_date)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_timecards_status ON timecards(status)
      `);
      return true;
    } finally {
      client.release();
    }
  }

  _computeTotal(row) {
    const sum =
      Number(row.mon || 0) +
      Number(row.tue || 0) +
      Number(row.wed || 0) +
      Number(row.thu || 0) +
      Number(row.fri || 0) +
      Number(row.sat || 0) +
      Number(row.sun || 0);
    return Math.round(sum * 100) / 100;
  }

  _format(row) {
    const total = this._computeTotal(row);
    return {
      id: row.id,
      job_seeker_id: row.job_seeker_id,
      placement_id: row.placement_id,
      week_start_date: toDateOnly(row.week_start_date),
      mon: Number(row.mon ?? 0),
      tue: Number(row.tue ?? 0),
      wed: Number(row.wed ?? 0),
      thu: Number(row.thu ?? 0),
      fri: Number(row.fri ?? 0),
      sat: Number(row.sat ?? 0),
      sun: Number(row.sun ?? 0),
      total_hours: total,
      status: row.status || "draft",
      submitted_at: row.submitted_at ? new Date(row.submitted_at).toISOString() : null,
      approved_at: row.approved_at ? new Date(row.approved_at).toISOString() : null,
      approved_by: row.approved_by ?? null,
      created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
      updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      placement: row.placement_title
        ? { id: row.placement_id, job_title: row.placement_title, organization_name: row.organization_name }
        : undefined,
    };
  }

  /** Validate and normalize payload (hours 0–24 per day, week_start is Monday). Returns { error } or { data }. */
  validatePayload(payload) {
    const weekStart = toDateOnly(payload.week_start_date);
    if (!weekStart) return { error: "week_start_date is required and must be a valid date (YYYY-MM-DD)." };
    if (!isMonday(weekStart)) return { error: "week_start_date must be a Monday." };

    const data = { week_start_date: weekStart };
    for (const day of DAYS) {
      let v = payload[day];
      if (v === undefined || v === null || v === "") v = 0;
      const num = Number(v);
      if (isNaN(num) || num < 0 || num > MAX_HOURS_PER_DAY) {
        return { error: `${day}: hours must be between 0 and ${MAX_HOURS_PER_DAY}.` };
      }
      data[day] = Math.round(num * Math.pow(10, MAX_DECIMAL)) / Math.pow(10, MAX_DECIMAL);
    }
    data.total_hours = Math.round(
      (data.mon + data.tue + data.wed + data.thu + data.fri + data.sat + data.sun) * 100
    ) / 100;
    return { data };
  }

  async listByJobSeekerId(jobSeekerId, options = {}) {
    const { fromWeek, toWeek, placementId, status } = options;
    const client = await this.pool.connect();
    try {
      let query = `
        SELECT t.*,
               j.job_title AS placement_title,
               o.name AS organization_name
        FROM timecards t
        JOIN placements p ON t.placement_id = p.id
        LEFT JOIN jobs j ON p.job_id = j.id
        LEFT JOIN organizations o ON COALESCE(p.organization_id, j.organization_id) = o.id
        WHERE t.job_seeker_id = $1
      `;
      const params = [jobSeekerId];
      let n = 2;
      if (fromWeek) {
        query += ` AND t.week_start_date >= $${n}`;
        params.push(fromWeek);
        n++;
      }
      if (toWeek) {
        query += ` AND t.week_start_date <= $${n}`;
        params.push(toWeek);
        n++;
      }
      if (placementId != null) {
        query += ` AND t.placement_id = $${n}`;
        params.push(placementId);
        n++;
      }
      if (status) {
        query += ` AND t.status = $${n}`;
        params.push(status);
        n++;
      }
      query += ` ORDER BY t.week_start_date DESC, t.placement_id, t.id DESC`;
      const result = await client.query(query, params);
      return result.rows.map((r) => this._format(r));
    } finally {
      client.release();
    }
  }

  async getById(id, jobSeekerId) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `
        SELECT t.*,
               j.job_title AS placement_title,
               o.name AS organization_name
        FROM timecards t
        JOIN placements p ON t.placement_id = p.id
        LEFT JOIN jobs j ON p.job_id = j.id
        LEFT JOIN organizations o ON COALESCE(p.organization_id, j.organization_id) = o.id
        WHERE t.id = $1 AND t.job_seeker_id = $2
        `,
        [id, jobSeekerId]
      );
      const row = result.rows[0];
      return row ? this._format(row) : null;
    } finally {
      client.release();
    }
  }

  async create(jobSeekerId, placementId, payload) {
    const v = this.validatePayload(payload);
    if (v.error) return { error: v.error };

    const client = await this.pool.connect();
    try {
      // Ensure placement belongs to this job seeker
      const placementCheck = await client.query(
        "SELECT id FROM placements WHERE id = $1 AND job_seeker_id = $2",
        [placementId, jobSeekerId]
      );
      if (placementCheck.rows.length === 0) {
        return { error: "Placement not found or access denied." };
      }

      const d = v.data;
      const result = await client.query(
        `
        INSERT INTO timecards (
          job_seeker_id, placement_id, week_start_date,
          mon, tue, wed, thu, fri, sat, sun, total_hours, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'draft')
        RETURNING *
        `,
        [
          jobSeekerId,
          placementId,
          d.week_start_date,
          d.mon,
          d.tue,
          d.wed,
          d.thu,
          d.fri,
          d.sat,
          d.sun,
          d.total_hours,
        ]
      );
      return { row: result.rows[0] };
    } catch (e) {
      if (e.code === "23505") return { error: "A timecard for this placement and week already exists." };
      throw e;
    } finally {
      client.release();
    }
  }

  async update(id, jobSeekerId, payload) {
    const v = this.validatePayload(payload);
    if (v.error) return { error: v.error };

    const client = await this.pool.connect();
    try {
      const existing = await client.query(
        "SELECT id, status FROM timecards WHERE id = $1 AND job_seeker_id = $2",
        [id, jobSeekerId]
      );
      if (existing.rows.length === 0) return { error: "Timecard not found or access denied." };
      if (existing.rows[0].status !== "draft") {
        return { error: "Only draft timecards can be updated." };
      }

      const d = v.data;
      const result = await client.query(
        `
        UPDATE timecards SET
          week_start_date = $2,
          mon = $3, tue = $4, wed = $5, thu = $6, fri = $7, sat = $8, sun = $9,
          total_hours = $10,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND job_seeker_id = $11
        RETURNING *
        `,
        [id, d.week_start_date, d.mon, d.tue, d.wed, d.thu, d.fri, d.sat, d.sun, d.total_hours, jobSeekerId]
      );
      return { row: result.rows[0] };
    } catch (e) {
      if (e.code === "23505") return { error: "A timecard for this placement and week already exists." };
      throw e;
    } finally {
      client.release();
    }
  }

  async submit(id, jobSeekerId) {
    const client = await this.pool.connect();
    try {
      const existing = await client.query(
        "SELECT id, status FROM timecards WHERE id = $1 AND job_seeker_id = $2",
        [id, jobSeekerId]
      );
      if (existing.rows.length === 0) return { error: "Timecard not found or access denied." };
      if (existing.rows[0].status !== "draft") {
        return { error: "Only draft timecards can be submitted." };
      }

      const result = await client.query(
        `
        UPDATE timecards SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND job_seeker_id = $2
        RETURNING *
        `,
        [id, jobSeekerId]
      );
      return { row: result.rows[0] };
    } finally {
      client.release();
    }
  }
}

module.exports = Timecard;
