// models/broadcastMessage.js
class BroadcastMessage {
  constructor(pool) {
    this.pool = pool;
  }

  async initTable() {
    let client;
    try {
      console.log("Initializing broadcast_messages table if needed...");
      client = await this.pool.connect();

      await client.query(`
        CREATE TABLE IF NOT EXISTS broadcast_messages (
          id SERIAL PRIMARY KEY,
          message TEXT NOT NULL,
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_broadcast_messages_created_at 
        ON broadcast_messages(created_at DESC)
      `);

      console.log("✅ Broadcast messages table initialized successfully");
      return true;
    } catch (error) {
      console.error("❌ Error initializing broadcast_messages table:", error.message);
      throw error;
    } finally {
      if (client) client.release();
    }
  }

  async create(data) {
    const {
      message,
      created_by = null,
    } = data;

    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `
        INSERT INTO broadcast_messages (
          message, created_by, created_at, updated_at
        )
        VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING *
        `,
        [message, created_by]
      );
      return result.rows[0];
    } catch (error) {
      console.error("Error creating broadcast message:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  async getAll(limit = 50) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `
        SELECT 
          m.*,
          u.name AS created_by_name
        FROM broadcast_messages m
        LEFT JOIN users u ON m.created_by = u.id
        ORDER BY m.created_at DESC
        LIMIT $1
        `,
        [limit]
      );
      return result.rows;
    } catch (error) {
      console.error("Error fetching broadcast messages:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  async getById(id) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `
        SELECT 
          m.*,
          u.name AS created_by_name
        FROM broadcast_messages m
        LEFT JOIN users u ON m.created_by = u.id
        WHERE m.id = $1
        `,
        [id]
      );
      return result.rows[0] || null;
    } catch (error) {
      console.error("Error fetching broadcast message:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  async delete(id) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        "DELETE FROM broadcast_messages WHERE id = $1 RETURNING *",
        [id]
      );
      return result.rows[0];
    } catch (error) {
      console.error("Error deleting broadcast message:", error);
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = BroadcastMessage;

