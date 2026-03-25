class Packet {
  constructor(pool) {
    this.pool = pool;
  }

  async initTable() {
    let client;
    try {
      client = await this.pool.connect();

      await client.query(`
        CREATE TABLE IF NOT EXISTS packets (
          id SERIAL PRIMARY KEY,
          packet_name VARCHAR(255) NOT NULL,
          created_by INTEGER REFERENCES users(id),
          status BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS packet_documents (
          id SERIAL PRIMARY KEY,
          packet_id INTEGER REFERENCES packets(id) ON DELETE CASCADE,
          template_document_id INTEGER REFERENCES template_documents(id) ON DELETE CASCADE,
          sort_order INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(packet_id, template_document_id)
        )
      `);

      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_packets_status ON packets(status)`
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_packet_documents_packet ON packet_documents(packet_id)`
      );

      return true;
    } finally {
      if (client) client.release();
    }
  }

  async list({ search = "" } = {}) {
    const client = await this.pool.connect();
    try {
      const q = `
        SELECT 
          p.id,
          p.packet_name,
          p.created_at,
          p.updated_at,
          COALESCE(COUNT(pd.id), 0)::int AS documents_count
        FROM packets p
        LEFT JOIN packet_documents pd ON pd.packet_id = p.id
        WHERE p.status = TRUE
          AND ($1 = '' OR LOWER(p.packet_name) LIKE LOWER('%' || $1 || '%'))
        GROUP BY p.id
        ORDER BY p.created_at DESC
      `;
      const r = await client.query(q, [search.trim()]);
      return r.rows;
    } finally {
      client.release();
    }
  }

  async getById(id) {
    const client = await this.pool.connect();
    try {
      const packetQ = `
        SELECT p.*
        FROM packets p
        WHERE p.id = $1 AND p.status = TRUE
      `;
      const pr = await client.query(packetQ, [id]);
      const packet = pr.rows[0];
      if (!packet) return null;

      const docsQ = `
        SELECT 
          td.id,
          td.document_name,
          td.category,
          td.file_path,
          pd.sort_order
        FROM packet_documents pd
        JOIN template_documents td ON td.id = pd.template_document_id
        WHERE pd.packet_id = $1 AND td.status = TRUE
        ORDER BY pd.sort_order ASC, pd.id ASC
      `;
      const dr = await client.query(docsQ, [id]);

      return {
        ...packet,
        documents: dr.rows || [],
      };
    } finally {
      client.release();
    }
  }

  async create({ packet_name, created_by = null, documents = [] }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const insertPacketQ = `
        INSERT INTO packets (packet_name, created_by, status, created_at, updated_at)
        VALUES ($1,$2,TRUE,NOW(),NOW())
        RETURNING *
      `;
      const pr = await client.query(insertPacketQ, [packet_name, created_by]);
      const packet = pr.rows[0];

      // normalize documents
      let normalized = [];

     
      if (
        Array.isArray(documents) &&
        documents.length &&
        typeof documents[0] === "number"
      ) {
        normalized = documents
          .map((id, idx) => ({
            template_document_id: Number(id),
            sort_order: idx + 1,
          }))
          .filter(
            (d) =>
              Number.isFinite(d.template_document_id) &&
              d.template_document_id > 0
          );
      } else {
      
        normalized = (Array.isArray(documents) ? documents : [])
          .map((d, idx) => {
            const templateId =
              Number(d?.template_document_id) ||
              Number(d?.document_id) || 
              NaN;

            const sortOrder = Number(d?.sort_order) || idx + 1;

            return {
              template_document_id: templateId,
              sort_order: sortOrder,
            };
          })
          .filter(
            (d) =>
              Number.isFinite(d.template_document_id) &&
              d.template_document_id > 0
          );
      }

      if (normalized.length) {
        const values = [];
        const placeholders = normalized
          .map((d, i) => {
            const base = i * 3;
            values.push(packet.id, d.template_document_id, d.sort_order);
            return `($${base + 1}, $${base + 2}, $${base + 3})`;
          })
          .join(",");

        await client.query(
          `INSERT INTO packet_documents (packet_id, template_document_id, sort_order)
           VALUES ${placeholders}
           ON CONFLICT (packet_id, template_document_id)
           DO UPDATE SET sort_order = EXCLUDED.sort_order`,
          values
        );
      }

      await client.query("COMMIT");
      return packet;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  
  async update(id, { packet_name = null, documents = null }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const upQ = `
      UPDATE packets
      SET packet_name = COALESCE($1, packet_name),
          updated_at = NOW()
      WHERE id = $2 AND status = TRUE
      RETURNING *
    `;
      const ur = await client.query(upQ, [packet_name, id]);
      const packet = ur.rows[0];

      if (!packet) {
        await client.query("ROLLBACK");
        return null;
      }

   
      if (documents !== null) {
        await client.query(
          `DELETE FROM packet_documents WHERE packet_id = $1`,
          [id]
        );

        if (Array.isArray(documents) && documents.length) {
          const rows = documents.map((d, idx) => [
            id,
            Number(d.template_document_id),
            Number.isFinite(Number(d.sort_order))
              ? Number(d.sort_order)
              : idx + 1,
          ]);

          const flat = rows.flat();
          const placeholders = rows
            .map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`)
            .join(",");

          await client.query(
            `INSERT INTO packet_documents (packet_id, template_document_id, sort_order)
           VALUES ${placeholders}`,
            flat
          );
        }
      }

      await client.query("COMMIT");
      return packet;
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
      const q = `
        UPDATE packets
        SET status = FALSE, updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `;
      const r = await client.query(q, [id]);
      return r.rows[0] || null;
    } finally {
      client.release();
    }
  }
}

module.exports = Packet;
