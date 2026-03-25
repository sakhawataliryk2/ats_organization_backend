class UserSession {
  constructor(pool) {
    this.pool = pool;
  }

  async initTable() {
    let client;
    try {
      console.log("Initializing user_sessions table if needed...");
      client = await this.pool.connect();

      await client.query(`
        CREATE TABLE IF NOT EXISTS user_sessions (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          session_id VARCHAR(255) UNIQUE NOT NULL,
          ip_address VARCHAR(45),
          user_agent TEXT,
          device_type VARCHAR(50),
          browser VARCHAR(100),
          os VARCHAR(100),
          screen_resolution VARCHAR(50),
          start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          end_time TIMESTAMP,
          duration_seconds INTEGER,
          pages_visited INTEGER DEFAULT 0,
          actions_performed INTEGER DEFAULT 0,
          is_active BOOLEAN DEFAULT TRUE,
          metadata JSONB
        )
      `);

      // Indexes for common queries
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id)
      `);
      
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_user_sessions_session_id ON user_sessions(session_id)
      `);
      
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_user_sessions_start_time ON user_sessions(start_time)
      `);
      
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_user_sessions_is_active ON user_sessions(is_active)
      `);

      console.log("user_sessions table initialized successfully");
    } catch (error) {
      console.error("Error initializing user_sessions table:", error);
      throw error;
    } finally {
      if (client) client.release();
    }
  }

  async createSession({ userId, sessionId, ipAddress, userAgent, metadata }) {
    let client;
    try {
      client = await this.pool.connect();
      
      // Parse user agent for device info
      const deviceInfo = this.parseUserAgent(userAgent);
      
      const result = await client.query(
        `INSERT INTO user_sessions 
          (user_id, session_id, ip_address, user_agent, device_type, browser, os, screen_resolution, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          userId,
          sessionId,
          ipAddress,
          userAgent,
          deviceInfo.deviceType,
          deviceInfo.browser,
          deviceInfo.os,
          deviceInfo.screenResolution,
          metadata || null
        ]
      );
      return result.rows[0];
    } catch (error) {
      console.error("Error creating session:", error);
      throw error;
    } finally {
      if (client) client.release();
    }
  }

  async updateSessionActivity(sessionId) {
    let client;
    try {
      client = await this.pool.connect();
      
      await client.query(
        `UPDATE user_sessions 
         SET last_activity = CURRENT_TIMESTAMP, 
             pages_visited = pages_visited + 1
         WHERE session_id = $1 AND is_active = TRUE`,
        [sessionId]
      );
    } catch (error) {
      console.error("Error updating session activity:", error);
    } finally {
      if (client) client.release();
    }
  }

  async recordAction(sessionId) {
    let client;
    try {
      client = await this.pool.connect();
      
      await client.query(
        `UPDATE user_sessions 
         SET last_activity = CURRENT_TIMESTAMP, 
             actions_performed = actions_performed + 1
         WHERE session_id = $1 AND is_active = TRUE`,
        [sessionId]
      );
    } catch (error) {
      console.error("Error recording action:", error);
    } finally {
      if (client) client.release();
    }
  }

  async endSession(sessionId) {
    let client;
    try {
      client = await this.pool.connect();
      
      const result = await client.query(
        `UPDATE user_sessions 
         SET end_time = CURRENT_TIMESTAMP, 
             is_active = FALSE,
             duration_seconds = EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - start_time))::INTEGER
         WHERE session_id = $1
         RETURNING *`,
        [sessionId]
      );
      return result.rows[0];
    } catch (error) {
      console.error("Error ending session:", error);
      throw error;
    } finally {
      if (client) client.release();
    }
  }

  async getSessions({ userId, startDate, endDate, limit = 50, offset = 0 }) {
    let client;
    try {
      client = await this.pool.connect();
      
      const conditions = [];
      const params = [];

      if (userId) {
        params.push(userId);
        conditions.push(`user_id = $${params.length}`);
      }

      if (startDate) {
        params.push(startDate);
        conditions.push(`start_time >= $${params.length}`);
      }

      if (endDate) {
        params.push(`${endDate} 23:59:59`);
        conditions.push(`start_time <= $${params.length}`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      
      params.push(limit);
      const limitIndex = params.length;
      params.push(offset);
      const offsetIndex = params.length;

      const query = `
        SELECT * FROM user_sessions
        ${whereClause}
        ORDER BY start_time DESC
        LIMIT $${limitIndex} OFFSET $${offsetIndex}
      `;

      const result = await client.query(query, params);

      const countResult = await client.query(
        `SELECT COUNT(*) FROM user_sessions ${whereClause}`,
        params.slice(0, params.length - 2)
      );

      return {
        sessions: result.rows,
        total: parseInt(countResult.rows[0].count, 10) || 0
      };
    } catch (error) {
      console.error("Error fetching sessions:", error);
      throw error;
    } finally {
      if (client) client.release();
    }
  }

  async getSessionStats({ userId, startDate, endDate }) {
    let client;
    try {
      client = await this.pool.connect();
      
      const conditions = [];
      const params = [];

      if (userId) {
        params.push(userId);
        conditions.push(`user_id = $${params.length}`);
      }

      if (startDate) {
        params.push(startDate);
        conditions.push(`start_time >= $${params.length}`);
      }

      if (endDate) {
        params.push(`${endDate} 23:59:59`);
        conditions.push(`start_time <= $${params.length}`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      // Overall stats
      const statsResult = await client.query(
        `SELECT 
          COUNT(*) as total_sessions,
          COUNT(CASE WHEN is_active = TRUE THEN 1 END) as active_sessions,
          COALESCE(SUM(duration_seconds), 0) as total_duration,
          COALESCE(AVG(duration_seconds), 0) as avg_duration,
          COALESCE(SUM(pages_visited), 0) as total_pages,
          COALESCE(SUM(actions_performed), 0) as total_actions,
          COUNT(DISTINCT user_id) as unique_users
        FROM user_sessions ${whereClause}`,
        params
      );

      // Daily breakdown
      const dailyResult = await client.query(
        `SELECT 
          DATE(start_time) as date,
          COUNT(*) as sessions,
          COALESCE(SUM(duration_seconds), 0) as total_duration,
          COALESCE(AVG(duration_seconds), 0) as avg_duration,
          COALESCE(SUM(pages_visited), 0) as pages_visited,
          COALESCE(SUM(actions_performed), 0) as actions
        FROM user_sessions ${whereClause}
        GROUP BY DATE(start_time)
        ORDER BY date DESC
        LIMIT 30`,
        params
      );

      // Device breakdown
      const deviceResult = await client.query(
        `SELECT 
          device_type,
          COUNT(*) as count,
          COALESCE(AVG(duration_seconds), 0) as avg_duration
        FROM user_sessions ${whereClause}
        GROUP BY device_type`,
        params
      );

      return {
        stats: statsResult.rows[0],
        daily: dailyResult.rows,
        devices: deviceResult.rows
      };
    } catch (error) {
      console.error("Error fetching session stats:", error);
      throw error;
    } finally {
      if (client) client.release();
    }
  }

  parseUserAgent(userAgent) {
    if (!userAgent) {
      return { deviceType: 'unknown', browser: 'unknown', os: 'unknown', screenResolution: null };
    }

    const ua = userAgent.toLowerCase();
    
    // Device type
    let deviceType = 'desktop';
    if (/(tablet|ipad|playbook|surface)/i.test(ua)) deviceType = 'tablet';
    else if (/(mobile|iphone|ipod|android|blackberry|windows phone)/i.test(ua)) deviceType = 'mobile';

    // Browser
    let browser = 'unknown';
    if (ua.includes('firefox')) browser = 'Firefox';
    else if (ua.includes('chrome')) browser = 'Chrome';
    else if (ua.includes('safari')) browser = 'Safari';
    else if (ua.includes('edge')) browser = 'Edge';
    else if (ua.includes('opera') || ua.includes('opr')) browser = 'Opera';

    // OS
    let os = 'unknown';
    if (ua.includes('windows')) os = 'Windows';
    else if (ua.includes('mac')) os = 'macOS';
    else if (ua.includes('linux')) os = 'Linux';
    else if (ua.includes('android')) os = 'Android';
    else if (ua.includes('ios') || ua.includes('iphone') || ua.includes('ipad')) os = 'iOS';

    return {
      deviceType,
      browser,
      os,
      screenResolution: null // Will be set client-side
    };
  }
}

module.exports = UserSession;
