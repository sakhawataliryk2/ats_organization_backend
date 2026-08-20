class TemplateDocument {
  constructor(pool) {
    this.pool = pool;
  }

  async initTable() {
    let client;
    try {
      client = await this.pool.connect();

      await client.query(`
        CREATE TABLE IF NOT EXISTS template_documents (
          id SERIAL PRIMARY KEY,
          document_name VARCHAR(255) NOT NULL,
          category VARCHAR(80) NOT NULL,
          description TEXT,
          approval_required BOOLEAN DEFAULT FALSE,
          additional_docs_required BOOLEAN DEFAULT FALSE,

          file_name VARCHAR(255),
          file_path TEXT,
          file_url TEXT,
          file_size INTEGER,
          mime_type VARCHAR(100),

          created_by INTEGER REFERENCES users(id),
          status BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS template_document_notifications (
          id SERIAL PRIMARY KEY,
          template_document_id INTEGER REFERENCES template_documents(id) ON DELETE CASCADE,
          user_id INTEGER REFERENCES users(id),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS template_document_mappings (
          id SERIAL PRIMARY KEY,
          template_document_id INTEGER REFERENCES template_documents(id) ON DELETE CASCADE,

          field_id INTEGER,
          field_name VARCHAR(120) NOT NULL,
          field_label VARCHAR(255),
          field_type VARCHAR(40) NOT NULL,

          who_fills VARCHAR(20) DEFAULT 'candidate',
          is_required BOOLEAN DEFAULT FALSE,
          max_characters INTEGER DEFAULT 255,
          format VARCHAR(30) DEFAULT 'none',
          populate_with_data BOOLEAN DEFAULT FALSE,
          data_flow_back BOOLEAN DEFAULT FALSE,

          sort_order INTEGER DEFAULT 0,
          x INTEGER DEFAULT 0,
y INTEGER DEFAULT 0,
w INTEGER DEFAULT 0,
h INTEGER DEFAULT 0,

          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_template_documents_status
        ON template_documents(status)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_template_document_notifications_doc
        ON template_document_notifications(template_document_id)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_template_document_mappings_doc
        ON template_document_mappings(template_document_id)
      `);
      await client.query(`
  ALTER TABLE template_document_mappings
    ADD COLUMN IF NOT EXISTS x INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS y INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS w INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS h INTEGER DEFAULT 0
`);
      await client.query(`
  ALTER TABLE template_documents
    ADD COLUMN IF NOT EXISTS file_url TEXT
`);
      await client.query(`
  ALTER TABLE template_documents
    ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE
`);

      await client.query(`
  CREATE INDEX IF NOT EXISTS idx_template_documents_is_archived
  ON template_documents(is_archived)
`);

      return true;
    } finally {
      if (client) client.release();
    }
  }
  async getAll({ archived = false } = {}) {
    const client = await this.pool.connect();
    try {
      const q = `
      SELECT 
        td.*, 
        u.name AS created_by_name,
        COALESCE(COUNT(m.id), 0)::int AS mapped_count
      FROM template_documents td
      LEFT JOIN users u ON u.id = td.created_by
      LEFT JOIN template_document_mappings m ON m.template_document_id = td.id
      WHERE td.status = TRUE
        AND td.is_archived = $1
      GROUP BY td.id, u.name
      ORDER BY td.created_at DESC
    `;
      const r = await client.query(q, [!!archived]);
      return r.rows;
    } finally {
      client.release();
    }
  }

  async getById(id) {
    const client = await this.pool.connect();
    try {
      const q = `
        SELECT td.*, u.name AS created_by_name
        FROM template_documents td
        LEFT JOIN users u ON u.id = td.created_by
        WHERE td.id = $1
      `;
      const r = await client.query(q, [id]);
      return r.rows[0] || null;
    } finally {
      client.release();
    }
  }

  async create(data) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const q = `
  INSERT INTO template_documents (
    document_name, category, description,
    approval_required, additional_docs_required,
    file_name, file_path, file_url, file_size, mime_type,
    created_by, status, created_at, updated_at
  )
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE,NOW(),NOW())
  RETURNING *
`;

      const values = [
        data.document_name,
        data.category,
        data.description || null,
        !!data.approval_required,
        !!data.additional_docs_required,
        data.file_name || null,
        data.file_path || null,
        data.file_url || null,
        data.file_size || null,
        data.mime_type || null,
        data.created_by || null,
      ];

      const inserted = await client.query(q, values);
      const doc = inserted.rows[0];

      if (
        Array.isArray(data.notification_user_ids) &&
        data.notification_user_ids.length
      ) {
        const rows = data.notification_user_ids.map((uid) => [doc.id, uid]);
        const flat = rows.flat();

        const placeholders = rows
          .map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`)
          .join(",");

        await client.query(
          `INSERT INTO template_document_notifications (template_document_id, user_id) VALUES ${placeholders}`,
          flat
        );
      }

      await client.query("COMMIT");
      return doc;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async update(id, data) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const q = `
  UPDATE template_documents
  SET document_name = COALESCE($1, document_name),
      category = COALESCE($2, category),
      description = COALESCE($3, description),
      approval_required = COALESCE($4, approval_required),
      additional_docs_required = COALESCE($5, additional_docs_required),
      file_name = COALESCE($6, file_name),
      file_path = COALESCE($7, file_path),
      file_url = COALESCE($8, file_url),
      file_size = COALESCE($9, file_size),
      mime_type = COALESCE($10, mime_type),
      updated_at = NOW()
  WHERE id = $11
  RETURNING *
`;

      const r = await client.query(q, [
        data.document_name ?? null,
        data.category ?? null,
        data.description ?? null,
        typeof data.approval_required === "boolean"
          ? data.approval_required
          : null,
        typeof data.additional_docs_required === "boolean"
          ? data.additional_docs_required
          : null,
        data.file_name ?? null,
        data.file_path ?? null,
        data.file_url ?? null,
        data.file_size ?? null,
        data.mime_type ?? null,
        id,
      ]);

      if (Array.isArray(data.notification_user_ids)) {
        await client.query(
          `DELETE FROM template_document_notifications WHERE template_document_id = $1`,
          [id]
        );

        if (data.notification_user_ids.length) {
          const rows = data.notification_user_ids.map((uid) => [id, uid]);
          const flat = rows.flat();
          const placeholders = rows
            .map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`)
            .join(",");
          await client.query(
            `INSERT INTO template_document_notifications (template_document_id, user_id) VALUES ${placeholders}`,
            flat
          );
        }
      }

      await client.query("COMMIT");
      return r.rows[0] || null;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async softDelete(id) {
    const client = await this.pool.connect();
    try {
      const q = `UPDATE template_documents SET status = FALSE, updated_at = NOW() WHERE id = $1 RETURNING *`;
      const r = await client.query(q, [id]);
      return r.rows[0] || null;
    } finally {
      client.release();
    }
  }
  async setArchive(id, archive = true) {
    const client = await this.pool.connect();
    try {
      const q = `
      UPDATE template_documents
      SET is_archived = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `;
      const r = await client.query(q, [id, !!archive]);
      return r.rows[0] || null;
    } finally {
      client.release();
    }
  }

  async getMappings(template_document_id) {
    const client = await this.pool.connect();
    try {
      const q = `
        SELECT *
        FROM template_document_mappings
        WHERE template_document_id = $1
        ORDER BY sort_order ASC, id ASC
      `;
      const r = await client.query(q, [template_document_id]);
      return r.rows || [];
    } finally {
      client.release();
    }
  }

  async replaceMappings(docId, fields) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        "DELETE FROM template_document_mappings WHERE template_document_id = $1",
        [docId]
      );

      const q = `
      INSERT INTO template_document_mappings
      (
        template_document_id,
        field_id,
        field_name,
        field_label,
        field_type,
        who_fills,
        is_required,
        max_characters,
        format,
        populate_with_data,
        data_flow_back,
        sort_order,
        x, y, w, h
      )
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    `;

      for (const f of fields) {
        await client.query(q, [
          docId,
          f.field_id,
          f.field_name,
          f.field_label,
          f.field_type,
          f.who_fills,
          f.is_required,
          f.max_characters,
          f.format,
          f.populate_with_data,
          f.data_flow_back,
          f.sort_order,
          f.x,
          f.y,
          f.w,
          f.h,
        ]);
      }

      await client.query("COMMIT");
      return true;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}

module.exports = TemplateDocument;
