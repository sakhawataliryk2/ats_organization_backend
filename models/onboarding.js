// models/onboarding.js
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

class Onboarding {
  constructor(pool) {
    this.pool = pool;
  }

  async initTables() {
    const client = await this.pool.connect();
    try {
      // 1) onboarding_sends
      await client.query(`
        CREATE TABLE IF NOT EXISTS onboarding_sends (
          id SERIAL PRIMARY KEY,
          job_seeker_id INTEGER NOT NULL REFERENCES job_seekers(id) ON DELETE CASCADE,
          recipient_email VARCHAR(255) NOT NULL,
          created_by INTEGER REFERENCES users(id),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await client.query(`
        ALTER TABLE onboarding_sends
        ADD COLUMN IF NOT EXISTS job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL;
      `);

      // 2) onboarding_send_items
      await client.query(`
        CREATE TABLE IF NOT EXISTS onboarding_send_items (
          id SERIAL PRIMARY KEY,
          onboarding_send_id INTEGER NOT NULL REFERENCES onboarding_sends(id) ON DELETE CASCADE,
          template_document_id INTEGER NOT NULL REFERENCES template_documents(id),
          status VARCHAR(30) NOT NULL DEFAULT 'SENT',
          sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          completed_at TIMESTAMP NULL,
          UNIQUE(onboarding_send_id, template_document_id)
        )
      `);

      // Ensure columns exist (idempotent)
      await client.query(`ALTER TABLE onboarding_send_items ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'SENT'`);
      await client.query(`ALTER TABLE onboarding_send_items ADD COLUMN IF NOT EXISTS sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
      await client.query(`ALTER TABLE onboarding_send_items ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP NULL`);

      // ✅ NEW: reminders + workflow + rejection
      await client.query(`ALTER TABLE onboarding_send_items ADD COLUMN IF NOT EXISTS next_reminder_at TIMESTAMP NULL`);
      await client.query(`ALTER TABLE onboarding_send_items ADD COLUMN IF NOT EXISTS last_reminded_at TIMESTAMP NULL`);
      await client.query(`ALTER TABLE onboarding_send_items ADD COLUMN IF NOT EXISTS requires_admin_review BOOLEAN NOT NULL DEFAULT FALSE`);
      await client.query(`ALTER TABLE onboarding_send_items ADD COLUMN IF NOT EXISTS has_hold BOOLEAN NOT NULL DEFAULT FALSE`);
      await client.query(`ALTER TABLE onboarding_send_items ADD COLUMN IF NOT EXISTS completed_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL`);
      await client.query(`ALTER TABLE onboarding_send_items ADD COLUMN IF NOT EXISTS rejected_reason TEXT NULL`);
      await client.query(`ALTER TABLE onboarding_send_items ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMP NULL`);
      await client.query(`ALTER TABLE onboarding_send_items ADD COLUMN IF NOT EXISTS rejected_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL`);

      // 3) portal accounts table (job seeker login)
      await client.query(`
        CREATE TABLE IF NOT EXISTS job_seeker_portal_accounts (
          id SERIAL PRIMARY KEY,
          job_seeker_id INTEGER NOT NULL UNIQUE REFERENCES job_seekers(id) ON DELETE CASCADE,
          email VARCHAR(255) NOT NULL,
          password_hash TEXT NOT NULL,
          must_reset_password BOOLEAN DEFAULT TRUE,
          created_by INTEGER REFERENCES users(id),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await client.query(`
        ALTER TABLE job_seeker_portal_accounts
        ADD COLUMN IF NOT EXISTS must_reset_password BOOLEAN NOT NULL DEFAULT true
      `);

      // indexes
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_onboarding_sends_job_seeker
        ON onboarding_sends(job_seeker_id)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_onboarding_send_items_send
        ON onboarding_send_items(onboarding_send_id)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_onboarding_send_items_status
        ON onboarding_send_items(status)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_onboarding_send_items_next_reminder
        ON onboarding_send_items(next_reminder_at)
      `);
      await client.query(`CREATE TABLE IF NOT EXISTS onboarding_item_submissions (
  id SERIAL PRIMARY KEY,
  onboarding_item_id INTEGER NOT NULL REFERENCES onboarding_send_items(id) ON DELETE CASCADE,
  job_seeker_id INTEGER NOT NULL REFERENCES job_seekers(id) ON DELETE CASCADE,
  template_document_id INTEGER NULL REFERENCES template_documents(id) ON DELETE SET NULL,
  submitted_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_onboarding_item_submissions_item
ON onboarding_item_submissions(onboarding_item_id);

CREATE INDEX IF NOT EXISTS idx_onboarding_item_submissions_jobseeker
ON onboarding_item_submissions(job_seeker_id);`);

      return true;
    } finally {
      client.release();
    }
  }

  async resolveTemplateDocIds({ packet_ids = [], document_ids = [] }) {
    const client = await this.pool.connect();
    try {
      const packetDocIds = [];

      if (Array.isArray(packet_ids) && packet_ids.length) {
        const r = await client.query(
          `
          SELECT DISTINCT pd.template_document_id
          FROM packet_documents pd
          JOIN packets p ON p.id = pd.packet_id
          JOIN template_documents td ON td.id = pd.template_document_id
          WHERE pd.packet_id = ANY($1::int[])
            AND p.status = TRUE
            AND td.status = TRUE
          `,
          [packet_ids.map(Number)]
        );

        for (const row of r.rows) packetDocIds.push(Number(row.template_document_id));
      }

      const direct = (Array.isArray(document_ids) ? document_ids : [])
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0);

      return [...new Set([...packetDocIds, ...direct])];
    } finally {
      client.release();
    }
  }

  // once doc sent, dont send again unless REJECTED
  async findAlreadySentActive(job_seeker_id, template_document_ids) {
    const client = await this.pool.connect();
    try {
      const ids = (Array.isArray(template_document_ids) ? template_document_ids : [])
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0);

      if (!ids.length) return [];

      const r = await client.query(
        `
        SELECT DISTINCT osi.template_document_id
        FROM onboarding_sends os
        JOIN onboarding_send_items osi ON osi.onboarding_send_id = os.id
        WHERE os.job_seeker_id = $1
          AND osi.template_document_id = ANY($2::int[])
          AND COALESCE(osi.status,'SENT') <> 'REJECTED'
        `,
        [Number(job_seeker_id), ids]
      );

      return (r.rows || []).map((x) => Number(x.template_document_id));
    } finally {
      client.release();
    }
  }

  async hasAnySend(job_seeker_id) {
    const client = await this.pool.connect();
    try {
      const r = await client.query(
        `SELECT 1 FROM onboarding_sends WHERE job_seeker_id=$1 LIMIT 1`,
        [Number(job_seeker_id)]
      );
      return r.rowCount > 0;
    } finally {
      client.release();
    }
  }

  generateTempPassword() {
    return crypto
      .randomBytes(6)
      .toString("base64")
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 10);
  }

  async getOrCreatePortalAccount({ job_seeker_id, email, created_by }) {
    const client = await this.pool.connect();
    try {
      const existing = await client.query(
        `SELECT id, email FROM job_seeker_portal_accounts WHERE job_seeker_id=$1`,
        [Number(job_seeker_id)]
      );

      if (existing.rowCount) return { created: false, tempPassword: null };

      const tempPassword = this.generateTempPassword();
      const password_hash = await bcrypt.hash(tempPassword, 10);

      await client.query(
        `
        INSERT INTO job_seeker_portal_accounts
          (job_seeker_id, email, password_hash, must_reset_password, created_by)
        VALUES ($1, $2, $3, TRUE, $4)
        `,
        [Number(job_seeker_id), String(email || ""), password_hash, created_by || null]
      );

      return { created: true, tempPassword };
    } finally {
      client.release();
    }
  }

  async createSend({ job_seeker_id, job_id, recipient_email, created_by, template_document_ids }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const sendRes = await client.query(
        `
        INSERT INTO onboarding_sends (job_seeker_id, job_id, recipient_email, created_by)
        VALUES ($1, $2, $3, $4)
        RETURNING *
        `,
        [Number(job_seeker_id), Number(job_id), String(recipient_email || ""), created_by || null]
      );

      const sendRow = sendRes.rows[0];

      if (Array.isArray(template_document_ids) && template_document_ids.length) {
        const ids = template_document_ids.map(Number).filter((n) => n > 0);

        const values = [];
        const placeholders = ids
          .map((docId, i) => {
            const base = i * 2;
            values.push(sendRow.id, docId);
            return `($${base + 1}, $${base + 2})`;
          })
          .join(",");

        // ✅ next_reminder_at default = NOW() + 6 hours (job seeker reminders)
        await client.query(
          `
          INSERT INTO onboarding_send_items (onboarding_send_id, template_document_id, next_reminder_at)
          VALUES ${placeholders.replace(/\)$/, ", NOW() + interval '6 hours')").replace(/\),/g, ", NOW() + interval '6 hours'),")}
          ON CONFLICT (onboarding_send_id, template_document_id) DO NOTHING
          `,
          values
        );
      }

      await client.query("COMMIT");
      return sendRow;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }


  // async listForJobSeeker(job_seeker_id) {
  //   const client = await this.pool.connect();
  //   try {
  //     const r = await client.query(
  //       `
  //       SELECT
  //         osi.id,
  //         td.id as template_document_id,
  //         td.document_name,
  //         osi.status,
  //         osi.sent_at,
  //         osi.completed_at,
  //         td.file_url,
  //         td.file_name,
  //         td.mime_type,
  //         COALESCE(
  //           json_agg(
  //             json_build_object(
  //               'field_name', f.field_name,
  //               'field_label', f.field_label,
  //               'field_type', f.field_type,
  //               'x', f.x,
  //               'y', f.y,
  //               'w', f.w,
  //               'h', f.h
  //             )
  //           ) FILTER (WHERE f.id IS NOT NULL),
  //           '[]'::json
  //         ) as mapped_fields
  //       FROM onboarding_sends os
  //       JOIN onboarding_send_items osi ON osi.onboarding_send_id = os.id
  //       JOIN template_documents td ON td.id = osi.template_document_id
  //       LEFT JOIN template_document_mappings f ON f.template_document_id = td.id
  //       WHERE os.job_seeker_id = $1
  //       GROUP BY osi.id, td.id
  //       ORDER BY osi.sent_at DESC
  //       `,
  //       [Number(job_seeker_id)]
  //     );
  //     return r.rows || [];
  //   } finally {
  //     client.release();
  //   }
  // }

  async insertJobSeekerNote({ job_seeker_id, text, created_by, action, about_references }) {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO job_seeker_notes (job_seeker_id, text, action, about_references, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [job_seeker_id, text, action || null, about_references || null, created_by]
      );
    } finally {
      client.release();
    }
  }

  async insertJobNote({ job_id, text, created_by, action, about_references }) {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO job_notes (job_id, text, action, about_references, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [job_id, text, action || null, about_references || null, created_by]
      );
    } finally {
      client.release();
    }
  }

  // ---------------------------
  // ✅ NEW: status transitions
  // ---------------------------
  async setItemStatus({ item_id, status, completed_by = null, setCompletedAt = false, clearReminders = false }) {
    const client = await this.pool.connect();
    try {
      await client.query(
        `
        UPDATE onboarding_send_items
        SET status = $2,
            completed_by = COALESCE($3, completed_by),
            completed_at = CASE WHEN $4 THEN NOW() ELSE completed_at END,
            next_reminder_at = CASE WHEN $5 THEN NULL ELSE next_reminder_at END
        WHERE id = $1
        `,
        [Number(item_id), status, completed_by, !!setCompletedAt, !!clearReminders]
      );
    } finally {
      client.release();
    }
  }

  async markReminderSentAndReschedule({ item_id, hours }) {
    const client = await this.pool.connect();
    try {
      await client.query(
        `
        UPDATE onboarding_send_items
        SET last_reminded_at = NOW(),
            next_reminder_at = NOW() + ($2 || ' hours')::interval
        WHERE id = $1
        `,
        [Number(item_id), Number(hours)]
      );
    } finally {
      client.release();
    }
  }

  async listDueJobSeekerReminders(limit = 100) {
    const client = await this.pool.connect();
    try {
      const r = await client.query(
        `
        SELECT
          oi.id AS item_id,
          oi.status,
          oi.next_reminder_at,
          os.job_seeker_id,
          os.job_id,
          td.document_name,
          js.email AS jobseeker_email,
          js.first_name, js.last_name,
          js.created_by AS jobseeker_owner_id,
          j.created_by AS job_owner_id,
          j.job_title
        FROM onboarding_send_items oi
        JOIN onboarding_sends os ON os.id = oi.onboarding_send_id
        JOIN template_documents td ON td.id = oi.template_document_id
        JOIN job_seekers js ON js.id = os.job_seeker_id
        JOIN jobs j ON j.id = os.job_id
        WHERE oi.next_reminder_at IS NOT NULL
          AND oi.next_reminder_at <= NOW()
          AND oi.status IN ('SENT','REJECTED','PENDING_JOBSEEKER','SUBMITTED')
        ORDER BY oi.next_reminder_at ASC
        LIMIT $1
        `,
        [Number(limit)]
      );
      return r.rows || [];
    } finally {
      client.release();
    }
  }

  async listDueAdminReminders(limit = 100) {
    const client = await this.pool.connect();
    try {
      const r = await client.query(
        `
        SELECT
          oi.id AS item_id,
          oi.status,
          oi.next_reminder_at,
          os.job_seeker_id,
          os.job_id,
          td.document_name,
          js.created_by AS jobseeker_owner_id,
          j.created_by AS job_owner_id,
          j.job_title
        FROM onboarding_send_items oi
        JOIN onboarding_sends os ON os.id = oi.onboarding_send_id
        JOIN template_documents td ON td.id = oi.template_document_id
        JOIN job_seekers js ON js.id = os.job_seeker_id
        JOIN jobs j ON j.id = os.job_id
        WHERE oi.next_reminder_at IS NOT NULL
          AND oi.next_reminder_at <= NOW()
          AND oi.status IN ('PENDING_ADMIN_REVIEW')
        ORDER BY oi.next_reminder_at ASC
        LIMIT $1
        `,
        [Number(limit)]
      );
      return r.rows || [];
    } finally {
      client.release();
    }
  }

  // ---------------------------
  // ✅ NEW: Reject + reset flow-back
  // ---------------------------

  _normalizeKey(label) {
    return String(label || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_");
  }
async resetFlowBackToDefaults({ job_seeker_id, template_document_id }) {
  const client = await this.pool.connect();
  try {
    // 1) get mappings (label + field_name both can exist in your system)
    const mapRes = await client.query(
      `
      SELECT field_label, field_name
      FROM template_document_mappings
      WHERE template_document_id = $1
      `,
      [Number(template_document_id)]
    );

    // 2) get current custom_fields
    const jsRes = await client.query(
      `SELECT custom_fields FROM job_seekers WHERE id = $1`,
      [Number(job_seeker_id)]
    );

    let customFields = jsRes.rows[0]?.custom_fields || {};

    // parse if string
    if (typeof customFields === "string") {
      try {
        customFields = JSON.parse(customFields || "{}");
      } catch {
        customFields = {};
      }
    }

    let changed = false;

    // 3) remove only mapped keys from custom_fields
    for (const row of mapRes.rows || []) {
      const label = row.field_label;
      const fname = row.field_name;

      if (label && Object.prototype.hasOwnProperty.call(customFields, label)) {
        delete customFields[label];
        changed = true;
      }

      // some systems store by field_name too
      if (fname && Object.prototype.hasOwnProperty.call(customFields, fname)) {
        delete customFields[fname];
        changed = true;
      }

      // also remove normalized key fallback (optional but helpful)
      if (label) {
        const norm = this._normalizeKey(label);
        if (norm && Object.prototype.hasOwnProperty.call(customFields, norm)) {
          delete customFields[norm];
          changed = true;
        }
      }
    }

    // 4) update only custom_fields
    if (changed) {
      await client.query(
        `UPDATE job_seekers SET custom_fields = $2::jsonb, updated_at = NOW() WHERE id=$1`,
        [Number(job_seeker_id), JSON.stringify(customFields)]
      );
    }

    return true;
  } finally {
    client.release();
  }
}

  async rejectItem({ item_id, rejected_by, reason }) {
    const client = await this.pool.connect();
    try {
      // Get context to reset flowback correctly
      const r = await client.query(
        `
        SELECT
          oi.id,
          oi.template_document_id,
          os.job_seeker_id,
          os.job_id
        FROM onboarding_send_items oi
        JOIN onboarding_sends os ON os.id = oi.onboarding_send_id
        WHERE oi.id = $1
        `,
        [Number(item_id)]
      );

      const ctx = r.rows[0];
      if (!ctx) return null;

      await client.query(
        `
        UPDATE onboarding_send_items
        SET status = 'REJECTED',
            rejected_reason = $2,
            rejected_at = NOW(),
            rejected_by = $3,
            completed_at = NULL,
            completed_by = NULL,
            next_reminder_at = NOW() + interval '6 hours'
        WHERE id = $1
        `,
        [Number(item_id), String(reason || ""), rejected_by || null]
      );

      // Reset flow-back fields to defaults
      await this.resetFlowBackToDefaults({
        job_seeker_id: Number(ctx.job_seeker_id),
        template_document_id: Number(ctx.template_document_id),
      });

      return { job_seeker_id: ctx.job_seeker_id, job_id: ctx.job_id, template_document_id: ctx.template_document_id };
    } finally {
      client.release();
    }
  }

  // ---------------------------
  // ✅ Timecard access hook (backend gate)
  // ---------------------------
  async isAllOnboardingCompleted(job_seeker_id) {
    const client = await this.pool.connect();
    try {
      const r = await client.query(
        `
        SELECT COUNT(*)::int AS total,
               SUM(CASE WHEN status IN ('APPROVED','COMPLETED') THEN 1 ELSE 0 END)::int AS done
        FROM onboarding_send_items oi
        JOIN onboarding_sends os ON os.id = oi.onboarding_send_id
        WHERE os.job_seeker_id = $1
        `,
        [Number(job_seeker_id)]
      );
      const row = r.rows[0] || { total: 0, done: 0 };
      return row.total > 0 && row.done === row.total;
    } finally {
      client.release();
    }
  }

  async hasApprovedContractPlacement(job_seeker_id) {
    const client = await this.pool.connect();
    try {
      const r = await client.query(
        `
        SELECT 1
        FROM placements
        WHERE job_seeker_id = $1
          AND (status = 'APPROVED' OR status = 'Approved')
          AND (placement_type = 'CONTRACT' OR employment_type = 'CONTRACT' OR 'CONTRACT' = 'CONTRACT')
        LIMIT 1
        `,
        [Number(job_seeker_id)]
      );
      return r.rowCount > 0;
    } catch (e) {
      // if placements schema differs, don't crash backend
      return false;
    } finally {
      client.release();
    }
  }

  async canAccessTimecard(job_seeker_id) {
    const allDone = await this.isAllOnboardingCompleted(job_seeker_id);
    if (!allDone) return false;
    const hasPlacement = await this.hasApprovedContractPlacement(job_seeker_id);
    return !!hasPlacement;
  }
  async getSendDetails(sendId) {
  const client = await this.pool.connect();
  try {
    const s = await client.query(`SELECT * FROM onboarding_sends WHERE id=$1`, [Number(sendId)]);
    const send = s.rows[0];
    if (!send) return null;

    const itemsRes = await client.query(
      `
      SELECT
        osi.id,
        osi.template_document_id,
        osi.status,
        td.document_name,
        td.category
      FROM onboarding_send_items osi
      JOIN template_documents td ON td.id = osi.template_document_id
      WHERE osi.onboarding_send_id = $1
      ORDER BY osi.id ASC
      `,
      [Number(sendId)]
    );

    // ✅ packets list (optional)
    // We infer packets from packet_documents mapping:
    const packetsRes = await client.query(
      `
      SELECT DISTINCT p.id, p.packet_name
      FROM packets p
      JOIN packet_documents pd ON pd.packet_id = p.id
      JOIN onboarding_send_items osi ON osi.template_document_id = pd.template_document_id
      WHERE osi.onboarding_send_id = $1
      ORDER BY p.packet_name ASC
      `,
      [Number(sendId)]
    );

    return {
      send,
      items: itemsRes.rows || [],
      packets: packetsRes.rows || [],
    };
  } finally {
    client.release();
  }
}
async getJobseekerProfile(job_seeker_id) {
  const client = await this.pool.connect();
  try {
    const jobseekerResult = await client.query(
      `SELECT * FROM job_seekers WHERE id = $1`, [Number(job_seeker_id)]
    );
    const js = jobseekerResult.rows[0];
    if (!js) return {};
    return js;
  } finally {
    client.release();
  }

}
async listForJobSeeker(job_seeker_id) {
  const client = await this.pool.connect();
  try {
    const r = await client.query(
      `
      SELECT
        osi.id,
        td.id as template_document_id,
        td.document_name,
        osi.status,
        osi.sent_at,
        osi.completed_at,
        td.file_url, -- Fetch the file_url from the template_documents table
        td.file_name, -- Optionally, you can also fetch file_name if needed
        td.mime_type, -- Fetch mime type, useful for rendering
        json_agg(
  json_build_object(
    'field_name', f.field_name,
    'field_label', f.field_label,
    'field_type', f.field_type,
    'x', f.x,   -- Yeh add karein
    'y', f.y,   -- Yeh add karein
    'w', f.w,   -- Yeh add karein
    'h', f.h    -- Yeh add karein
  )
) as mapped_fields
      FROM onboarding_sends os
      JOIN onboarding_send_items osi ON osi.onboarding_send_id = os.id
      JOIN template_documents td ON td.id = osi.template_document_id
      LEFT JOIN template_document_mappings f ON f.template_document_id = td.id
      WHERE os.job_seeker_id = $1
      GROUP BY osi.id, td.id
      ORDER BY osi.sent_at DESC
      `,
      [Number(job_seeker_id)]
    );
    return r.rows || []; // Return documents with mapped fields and file_url
  } finally {
    client.release(); // Always release the client after the query
  }
}
async getJobseekerData(job_seeker_id, template_document_id) {
  const client = await this.pool.connect();
  try {
    // 1. Pehle mappings uthain (e.g., Field_1 -> "First Name")
    const mappingsResult = await client.query(
      `SELECT field_name, field_label FROM template_document_mappings WHERE template_document_id = $1`,
      [template_document_id]
    );

    // 2. Jobseeker ka poora data uthain (including custom_fields)
    const jobseekerResult = await client.query(
      `SELECT * FROM job_seekers WHERE id = $1`,
      [Number(job_seeker_id)]
    );

    const js = jobseekerResult.rows[0];
    if (!js) return {};

    const mappedData = {};

    // 3. Mapping loop: label match karein
    mappingsResult.rows.forEach(mapping => {
      const label = mapping.field_label; // e.g., "First Name" or "Address"
      
      // Pehle check karein agar ye standard column hai (lowercase check)
      const standardKey = label.toLowerCase().replace(" ", "_");
      
      if (js[standardKey] !== undefined) {
        mappedData[mapping.field_name] = js[standardKey];
      } 
      // Phir check karein custom_fields JSON ke andar
      else if (js.custom_fields && js.custom_fields[label] !== undefined) {
        mappedData[mapping.field_name] = js.custom_fields[label];
      }
      else {
        mappedData[mapping.field_name] = ""; // Agar kuch na mile
      }
    });

    return mappedData;
  } finally {
    client.release();
  }
}
async saveSubmission({ onboarding_item_id, job_seeker_id, template_document_id, submitted_fields }) {
  const client = await this.pool.connect();
  try {
    await client.query(
      `
      INSERT INTO onboarding_item_submissions
      (onboarding_item_id, job_seeker_id, template_document_id, submitted_fields)
      VALUES ($1, $2, $3, $4)
      `,
      [Number(onboarding_item_id), Number(job_seeker_id), Number(template_document_id), submitted_fields]
    );
  } finally {
    client.release();
  }
}
async applyDynamicFlowBack({ job_seeker_id, template_document_id, submitted_fields }) {
  const client = await this.pool.connect();
  try {
    // 1️⃣ get mappings
    const mapRes = await client.query(
      `SELECT field_name, field_label 
       FROM template_document_mappings 
       WHERE template_document_id = $1`,
      [Number(template_document_id)]
    );

    const mappings = mapRes.rows;

    // 2️⃣ get job seeker
    const jsRes = await client.query(
      `SELECT * FROM job_seekers WHERE id=$1`,
      [Number(job_seeker_id)]
    );

    const js = jsRes.rows[0];
    if (!js) return;

    let customFields = js.custom_fields || {};

    for (const field of submitted_fields) {
      const mapping = mappings.find(m => m.field_name === field.name);
      if (!mapping) continue;

      const label = mapping.field_label;
      const standardKey = label.toLowerCase().replace(/\s+/g, "_");

      // agar job_seekers column exist karta hai
      if (js.hasOwnProperty(standardKey)) {
        await client.query(
          `UPDATE job_seekers SET "${standardKey}"=$2 WHERE id=$1`,
          [Number(job_seeker_id), field.value]
        );
      } else {
        // warna custom_fields me save karo
        customFields[label] = field.value;
      }
    }

    // update custom_fields
    await client.query(
      `UPDATE job_seekers SET custom_fields=$2 WHERE id=$1`,
      [Number(job_seeker_id), customFields]
    );

  } finally {
    client.release();
  }
}
}

module.exports = Onboarding;