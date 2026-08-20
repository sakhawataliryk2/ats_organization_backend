class FieldChange {
  constructor(pool) {
    this.pool = pool;
  }

  async initTable() {
    let client;
    try {
      console.log("Initializing field_changes table if needed...");
      client = await this.pool.connect();

      await client.query(`
        CREATE TABLE IF NOT EXISTS field_changes (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          user_name VARCHAR(255),
          entity_type VARCHAR(100) NOT NULL,
          entity_id VARCHAR(100) NOT NULL,
          entity_label VARCHAR(500),
          field_name VARCHAR(255) NOT NULL,
          field_label VARCHAR(255),
          old_value TEXT,
          new_value TEXT,
          change_type VARCHAR(50) DEFAULT 'update',
          change_reason VARCHAR(500),
          metadata JSONB,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Indexes
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_field_changes_user_id ON field_changes(user_id)
      `);
      
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_field_changes_entity ON field_changes(entity_type, entity_id)
      `);
      
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_field_changes_field_name ON field_changes(field_name)
      `);
      
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_field_changes_created_at ON field_changes(created_at)
      `);

      console.log("field_changes table initialized successfully");
    } catch (error) {
      console.error("Error initializing field_changes table:", error);
      throw error;
    } finally {
      if (client) client.release();
    }
  }

  async logFieldChange({
    userId,
    userName,
    entityType,
    entityId,
    entityLabel,
    fieldName,
    fieldLabel,
    oldValue,
    newValue,
    changeType = 'update',
    changeReason,
    metadata
  }) {
    let client;
    try {
      client = await this.pool.connect();
      
      const result = await client.query(
        `INSERT INTO field_changes 
          (user_id, user_name, entity_type, entity_id, entity_label, field_name, field_label, old_value, new_value, change_type, change_reason, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          userId,
          userName,
          entityType,
          String(entityId),
          entityLabel,
          fieldName,
          fieldLabel,
          oldValue,
          newValue,
          changeType,
          changeReason,
          metadata ? JSON.stringify(metadata) : null
        ]
      );
      return result.rows[0];
    } catch (error) {
      console.error("Error logging field change:", error);
      throw error;
    } finally {
      if (client) client.release();
    }
  }

  async getFieldChanges({ userId, entityType, entityId, fieldName, startDate, endDate, limit = 100, offset = 0 }) {
    let client;
    try {
      client = await this.pool.connect();
      
      const conditions = [];
      const params = [];

      if (userId) {
        params.push(userId);
        conditions.push(`user_id = $${params.length}`);
      }

      if (entityType) {
        params.push(entityType);
        conditions.push(`entity_type = $${params.length}`);
      }

      if (entityId) {
        params.push(String(entityId));
        conditions.push(`entity_id = $${params.length}`);
      }

      if (fieldName) {
        params.push(fieldName);
        conditions.push(`field_name = $${params.length}`);
      }

      if (startDate) {
        params.push(startDate);
        conditions.push(`created_at >= $${params.length}`);
      }

      if (endDate) {
        params.push(`${endDate} 23:59:59`);
        conditions.push(`created_at <= $${params.length}`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      
      params.push(limit);
      const limitIndex = params.length;
      params.push(offset);
      const offsetIndex = params.length;

      const query = `
        SELECT * FROM field_changes
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${limitIndex} OFFSET $${offsetIndex}
      `;

      const result = await client.query(query, params);

      const countResult = await client.query(
        `SELECT COUNT(*) FROM field_changes ${whereClause}`,
        params.slice(0, params.length - 2)
      );

      return {
        changes: result.rows,
        total: parseInt(countResult.rows[0].count, 10) || 0
      };
    } catch (error) {
      console.error("Error fetching field changes:", error);
      throw error;
    } finally {
      if (client) client.release();
    }
  }

  async getFieldChangeStats({ userId, entityType, startDate, endDate }) {
    let client;
    try {
      client = await this.pool.connect();
      
      const conditions = [];
      const params = [];

      if (userId) {
        params.push(userId);
        conditions.push(`user_id = $${params.length}`);
      }

      if (entityType) {
        params.push(entityType);
        conditions.push(`entity_type = $${params.length}`);
      }

      if (startDate) {
        params.push(startDate);
        conditions.push(`created_at >= $${params.length}`);
      }

      if (endDate) {
        params.push(`${endDate} 23:59:59`);
        conditions.push(`created_at <= $${params.length}`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      // Most changed fields
      const topFields = await client.query(
        `SELECT 
          field_name,
          field_label,
          COUNT(*) as change_count,
          COUNT(DISTINCT user_id) as users_making_changes,
          COUNT(DISTINCT entity_id) as entities_affected
        FROM field_changes ${whereClause}
        GROUP BY field_name, field_label
        ORDER BY change_count DESC
        LIMIT 20`,
        params
      );

      // Changes by entity type
      const byEntityType = await client.query(
        `SELECT 
          entity_type,
          COUNT(*) as change_count,
          COUNT(DISTINCT user_id) as users,
          COUNT(DISTINCT entity_id) as entities
        FROM field_changes ${whereClause}
        GROUP BY entity_type
        ORDER BY change_count DESC`,
        params
      );

      // Changes by user
      const byUser = await client.query(
        `SELECT 
          user_id,
          user_name,
          COUNT(*) as change_count,
          COUNT(DISTINCT entity_type) as entity_types_touched
        FROM field_changes ${whereClause}
        GROUP BY user_id, user_name
        ORDER BY change_count DESC
        LIMIT 20`,
        params
      );

      // Daily changes
      const dailyChanges = await client.query(
        `SELECT 
          DATE(created_at) as date,
          COUNT(*) as changes
        FROM field_changes ${whereClause}
        GROUP BY DATE(created_at)
        ORDER BY date DESC
        LIMIT 30`,
        params
      );

      return {
        topFields: topFields.rows,
        byEntityType: byEntityType.rows,
        byUser: byUser.rows,
        dailyChanges: dailyChanges.rows
      };
    } catch (error) {
      console.error("Error fetching field change stats:", error);
      throw error;
    } finally {
      if (client) client.release();
    }
  }
}

module.exports = FieldChange;
