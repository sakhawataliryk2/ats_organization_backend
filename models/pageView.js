class PageView {
  constructor(pool) {
    this.pool = pool;
  }

  async initTable() {
    let client;
    try {
      console.log("Initializing page_views table if needed...");
      client = await this.pool.connect();

      await client.query(`
        CREATE TABLE IF NOT EXISTS page_views (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          session_id VARCHAR(255),
          page_path VARCHAR(500) NOT NULL,
          page_title VARCHAR(255),
          referrer VARCHAR(500),
          utm_source VARCHAR(255),
          utm_medium VARCHAR(255),
          utm_campaign VARCHAR(255),
          query_params JSONB,
          time_on_page_seconds INTEGER,
          scroll_depth INTEGER,
          click_count INTEGER DEFAULT 0,
          form_fills INTEGER DEFAULT 0,
          is_impression BOOLEAN DEFAULT FALSE,
          viewport_width INTEGER,
          viewport_height INTEGER,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Indexes
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_page_views_user_id ON page_views(user_id)
      `);
      
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_page_views_session_id ON page_views(session_id)
      `);
      
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_page_views_page_path ON page_views(page_path)
      `);
      
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_page_views_created_at ON page_views(created_at)
      `);

      console.log("page_views table initialized successfully");
    } catch (error) {
      console.error("Error initializing page_views table:", error);
      throw error;
    } finally {
      if (client) client.release();
    }
  }

  async logPageView({
    userId,
    sessionId,
    pagePath,
    pageTitle,
    referrer,
    utmSource,
    utmMedium,
    utmCampaign,
    queryParams,
    viewportWidth,
    viewportHeight,
    isImpression = false
  }) {
    let client;
    try {
      client = await this.pool.connect();
      
      const result = await client.query(
        `INSERT INTO page_views 
          (user_id, session_id, page_path, page_title, referrer, utm_source, utm_medium, utm_campaign, query_params, viewport_width, viewport_height, is_impression)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          userId,
          sessionId,
          pagePath,
          pageTitle,
          referrer,
          utmSource,
          utmMedium,
          utmCampaign,
          queryParams ? JSON.stringify(queryParams) : null,
          viewportWidth,
          viewportHeight,
          isImpression
        ]
      );
      return result.rows[0];
    } catch (error) {
      console.error("Error logging page view:", error);
      throw error;
    } finally {
      if (client) client.release();
    }
  }

  async updatePageEngagement(pageViewId, { timeOnPage, scrollDepth, clickCount, formFills }) {
    let client;
    try {
      client = await this.pool.connect();
      
      const updates = [];
      const params = [pageViewId];
      
      if (timeOnPage !== undefined) {
        params.push(timeOnPage);
        updates.push(`time_on_page_seconds = $${params.length}`);
      }
      
      if (scrollDepth !== undefined) {
        params.push(scrollDepth);
        updates.push(`scroll_depth = $${params.length}`);
      }
      
      if (clickCount !== undefined) {
        params.push(clickCount);
        updates.push(`click_count = $${params.length}`);
      }
      
      if (formFills !== undefined) {
        params.push(formFills);
        updates.push(`form_fills = $${params.length}`);
      }

      if (updates.length === 0) return;

      const result = await client.query(
        `UPDATE page_views SET ${updates.join(', ')} WHERE id = $1 RETURNING *`,
        params
      );
      return result.rows[0];
    } catch (error) {
      console.error("Error updating page engagement:", error);
      throw error;
    } finally {
      if (client) client.release();
    }
  }

  async getPageViews({ userId, sessionId, pagePath, startDate, endDate, limit = 100, offset = 0 }) {
    let client;
    try {
      client = await this.pool.connect();
      
      const conditions = [];
      const params = [];

      if (userId) {
        params.push(userId);
        conditions.push(`user_id = $${params.length}`);
      }

      if (sessionId) {
        params.push(sessionId);
        conditions.push(`session_id = $${params.length}`);
      }

      if (pagePath) {
        params.push(`%${pagePath}%`);
        conditions.push(`page_path LIKE $${params.length}`);
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
        SELECT * FROM page_views
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${limitIndex} OFFSET $${offsetIndex}
      `;

      const result = await client.query(query, params);

      const countResult = await client.query(
        `SELECT COUNT(*) FROM page_views ${whereClause}`,
        params.slice(0, params.length - 2)
      );

      return {
        pageViews: result.rows,
        total: parseInt(countResult.rows[0].count, 10) || 0
      };
    } catch (error) {
      console.error("Error fetching page views:", error);
      throw error;
    } finally {
      if (client) client.release();
    }
  }

  async getPageAnalytics({ startDate, endDate, limit = 20 }) {
    let client;
    try {
      client = await this.pool.connect();
      
      const conditions = [];
      const params = [];

      if (startDate) {
        params.push(startDate);
        conditions.push(`created_at >= $${params.length}`);
      }

      if (endDate) {
        params.push(`${endDate} 23:59:59`);
        conditions.push(`created_at <= $${params.length}`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      // Most visited pages
      const popularPages = await client.query(
        `SELECT 
          page_path,
          page_title,
          COUNT(*) as view_count,
          COUNT(DISTINCT user_id) as unique_users,
          COALESCE(AVG(time_on_page_seconds), 0) as avg_time_on_page,
          COALESCE(AVG(scroll_depth), 0) as avg_scroll_depth,
          COALESCE(SUM(click_count), 0) as total_clicks
        FROM page_views ${whereClause}
        GROUP BY page_path, page_title
        ORDER BY view_count DESC
        LIMIT $${params.length + 1}`,
        [...params, limit]
      );

      // Daily page views
      const dailyViews = await client.query(
        `SELECT 
          DATE(created_at) as date,
          COUNT(*) as views,
          COUNT(DISTINCT user_id) as unique_users,
          COUNT(DISTINCT session_id) as sessions
        FROM page_views ${whereClause}
        GROUP BY DATE(created_at)
        ORDER BY date DESC
        LIMIT 30`,
        params
      );

      // Top referrers
      const topReferrers = await client.query(
        `SELECT 
          referrer,
          COUNT(*) as count
        FROM page_views ${whereClause}
          ${whereClause ? "AND" : "WHERE"} referrer IS NOT NULL 
          AND referrer != ''
        GROUP BY referrer
        ORDER BY count DESC
        LIMIT 10`,
        params
      );

      // UTM breakdown
      const utmBreakdown = await client.query(
        `SELECT 
          utm_source,
          utm_medium,
          utm_campaign,
          COUNT(*) as count
        FROM page_views ${whereClause}
          ${whereClause ? "AND" : "WHERE"} utm_source IS NOT NULL
        GROUP BY utm_source, utm_medium, utm_campaign
        ORDER BY count DESC
        LIMIT 20`,
        params
      );

      return {
        popularPages: popularPages.rows,
        dailyViews: dailyViews.rows,
        topReferrers: topReferrers.rows,
        utmBreakdown: utmBreakdown.rows
      };
    } catch (error) {
      console.error("Error fetching page analytics:", error);
      throw error;
    } finally {
      if (client) client.release();
    }
  }
}

module.exports = PageView;
