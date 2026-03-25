// models/headerConfig.js
class HeaderConfig {
  constructor(pool) {
    this.pool = pool;
  }

  async initTable() {
    let client;
    try {
      client = await this.pool.connect();

      await client.query(`
        CREATE TABLE IF NOT EXISTS header_configs (
          id SERIAL PRIMARY KEY,
          entity_type VARCHAR(50) NOT NULL UNIQUE,
          header_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
          list_columns JSONB NOT NULL DEFAULT '[]'::jsonb,
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_header_configs_entity_type
        ON header_configs(entity_type)
      `);

      return true;
    } finally {
      if (client) client.release();
    }
  }

  async getByEntityType(entityType, configType = "header") {
    let client;
    try {
      client = await this.pool.connect();

      const column =
        configType === "columns" ? "list_columns" : "header_fields";

      const query = `
        SELECT id, entity_type, ${column} AS fields, created_at, updated_at
        FROM header_configs
        WHERE entity_type = $1
      `;

      const result = await client.query(query, [entityType]);
      return result.rows[0] || null;
    } finally {
      if (client) client.release();
    }
  }

  async upsert(entityType, fields, userId, configType = "header") {
    let client;
    try {
      client = await this.pool.connect();

      const column =
        configType === "columns" ? "list_columns" : "header_fields";

      const q = `
        INSERT INTO header_configs (entity_type, ${column}, created_by, updated_by)
        VALUES ($1, $2::jsonb, $3, $3)
        ON CONFLICT (entity_type)
        DO UPDATE SET
          ${column} = EXCLUDED.${column},
          updated_by = EXCLUDED.updated_by,
          updated_at = CURRENT_TIMESTAMP
        RETURNING id, entity_type, ${column} AS fields, created_at, updated_at
      `;

      const safeFields = Array.isArray(fields) ? fields : [];

      const result = await client.query(q, [
        entityType,
        JSON.stringify(safeFields),
        userId || null,
      ]);

      return result.rows[0];
    } finally {
      if (client) client.release();
    }
  }
}

module.exports = HeaderConfig;
