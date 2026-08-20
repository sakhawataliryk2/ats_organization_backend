class OrganizationDefaultDocument {
  constructor(pool) {
    this.pool = pool;
  }

  async initTable() {
    let client;
    try {
      client = await this.pool.connect();

      await client.query(`
        CREATE TABLE IF NOT EXISTS organization_default_documents (
          id SERIAL PRIMARY KEY,
          slot VARCHAR(50) NOT NULL UNIQUE,
          template_document_id INTEGER REFERENCES template_documents(id) ON DELETE SET NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_org_default_docs_slot
        ON organization_default_documents(slot)
      `);

      // Direct file upload for organization welcome (separate from onboarding template docs)
      await client.query(`
        ALTER TABLE organization_default_documents
        ADD COLUMN IF NOT EXISTS file_url TEXT,
        ADD COLUMN IF NOT EXISTS file_name VARCHAR(255),
        ADD COLUMN IF NOT EXISTS mime_type VARCHAR(100)
      `);

      return true;
    } finally {
      if (client) client.release();
    }
  }

  async getBySlot(slot) {
    let client;
    try {
      client = await this.pool.connect();
      const q = `
        SELECT odd.id, odd.slot, odd.template_document_id, odd.created_at, odd.updated_at,
               odd.file_url AS slot_file_url, odd.file_name AS slot_file_name, odd.mime_type AS slot_mime_type,
               td.document_name, td.file_url AS td_file_url, td.file_path AS td_file_path, td.file_name AS td_file_name, td.mime_type AS td_mime_type
        FROM organization_default_documents odd
        LEFT JOIN template_documents td ON td.id = odd.template_document_id
        WHERE odd.slot = $1
      `;
      const r = await client.query(q, [slot]);
      const row = r.rows[0] || null;
      if (!row) return null;
      // Normalize: prefer direct slot file (organization upload) over template
      return {
        ...row,
        file_url: row.slot_file_url || row.td_file_url,
        file_path: row.slot_file_url || row.td_file_path,
        document_name: row.slot_file_name || row.document_name || "Welcome Document",
        file_name: row.slot_file_name || row.td_file_name,
        mime_type: row.slot_mime_type || row.td_mime_type,
      };
    } finally {
      if (client) client.release();
    }
  }

  async getAll() {
    let client;
    try {
      client = await this.pool.connect();
      const q = `
        SELECT odd.*, td.document_name, td.file_url, td.file_path, td.file_name, td.mime_type, td.category
        FROM organization_default_documents odd
        LEFT JOIN template_documents td ON td.id = odd.template_document_id
        ORDER BY odd.slot
      `;
      const r = await client.query(q);
      return r.rows;
    } finally {
      if (client) client.release();
    }
  }

  async setSlot(slot, template_document_id) {
    let client;
    try {
      client = await this.pool.connect();

      const existing = await client.query(
        "SELECT id FROM organization_default_documents WHERE slot = $1",
        [slot]
      );

      if (existing.rows[0]) {
        const q = `
          UPDATE organization_default_documents
          SET template_document_id = $2, file_url = NULL, file_name = NULL, mime_type = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE slot = $1
          RETURNING *
        `;
        const r = await client.query(q, [slot, template_document_id]);
        return r.rows[0];
      } else {
        const q = `
          INSERT INTO organization_default_documents (slot, template_document_id)
          VALUES ($1, $2)
          RETURNING *
        `;
        const r = await client.query(q, [slot, template_document_id]);
        return r.rows[0];
      }
    } finally {
      if (client) client.release();
    }
  }

  /** Set slot to a direct-uploaded file (no link to template_documents). Used for Organization welcome only. */
  async setSlotFile(slot, { file_url, file_name, mime_type }) {
    let client;
    try {
      client = await this.pool.connect();

      const existing = await client.query(
        "SELECT id FROM organization_default_documents WHERE slot = $1",
        [slot]
      );

      if (existing.rows[0]) {
        const q = `
          UPDATE organization_default_documents
          SET template_document_id = NULL, file_url = $2, file_name = $3, mime_type = $4, updated_at = CURRENT_TIMESTAMP
          WHERE slot = $1
          RETURNING *
        `;
        const r = await client.query(q, [
          slot,
          file_url || null,
          file_name || null,
          mime_type || null,
        ]);
        return r.rows[0];
      } else {
        const q = `
          INSERT INTO organization_default_documents (slot, file_url, file_name, mime_type)
          VALUES ($1, $2, $3, $4)
          RETURNING *
        `;
        const r = await client.query(q, [
          slot,
          file_url || null,
          file_name || null,
          mime_type || null,
        ]);
        return r.rows[0];
      }
    } finally {
      if (client) client.release();
    }
  }

  async clearSlot(slot) {
    let client;
    try {
      client = await this.pool.connect();
      const q = `
        UPDATE organization_default_documents
        SET template_document_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE slot = $1
        RETURNING *
      `;
      const r = await client.query(q, [slot]);
      return r.rows[0];
    } finally {
      if (client) client.release();
    }
  }
}

module.exports = OrganizationDefaultDocument;
