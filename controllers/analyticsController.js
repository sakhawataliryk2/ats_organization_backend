const UserSession = require("../models/userSession");
const PageView = require("../models/pageView");
const FieldChange = require("../models/fieldChange");
const ActivityLog = require("../models/activityLog");

class AnalyticsController {
  constructor(pool) {
    this.sessionModel = new UserSession(pool);
    this.pageViewModel = new PageView(pool);
    this.fieldChangeModel = new FieldChange(pool);
    this.activityLogModel = new ActivityLog(pool);

    this.initTables = this.initTables.bind(this);
    this.getDashboardStats = this.getDashboardStats.bind(this);
  }

  async initTables() {
    await this.sessionModel.initTable();
    await this.pageViewModel.initTable();
    await this.fieldChangeModel.initTable();
  }

  // GET /api/analytics/dashboard - Main dashboard stats
  async getDashboardStats(req, res) {
    try {
      const { start, startDate, end, endDate, userId } = req.query;
      const resolvedStart = start || startDate || null;
      const resolvedEnd = end || endDate || null;
      const resolvedUserId = userId || null;

      // Get session stats
      const sessionStats = await this.sessionModel.getSessionStats({
        userId: resolvedUserId,
        startDate: resolvedStart,
        endDate: resolvedEnd
      });

      // Get page analytics
      const pageAnalytics = await this.pageViewModel.getPageAnalytics({
        startDate: resolvedStart,
        endDate: resolvedEnd,
        limit: 15
      });

      // Get field change stats
      const fieldChangeStats = await this.fieldChangeModel.getFieldChangeStats({
        userId: resolvedUserId,
        startDate: resolvedStart,
        endDate: resolvedEnd
      });

      // Get activity summary
      const activitySummary = await this.activityLogModel.getSummary({
        userId: resolvedUserId,
        startDate: resolvedStart,
        endDate: resolvedEnd
      });

      return res.status(200).json({
        success: true,
        sessions: sessionStats,
        pages: pageAnalytics,
        fieldChanges: fieldChangeStats,
        activities: activitySummary
      });
    } catch (error) {
      console.error("Error fetching dashboard stats:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch dashboard stats",
        error: process.env.NODE_ENV === "production" ? undefined : error.message
      });
    }
  }

  // POST /api/analytics/session - Create/update session
  async manageSession(req, res) {
    try {
      const userId = req.user?.id;
      const { sessionId, action, screenResolution, ...pageData } = req.body || {};

      if (!sessionId) {
        return res.status(400).json({
          success: false,
          message: "sessionId is required"
        });
      }

      const ipAddress = req.ip || req.connection?.remoteAddress || null;
      const userAgent = req.headers["user-agent"];

      if (action === "start") {
        const session = await this.sessionModel.createSession({
          userId,
          sessionId,
          ipAddress,
          userAgent,
          metadata: { screenResolution }
        });
        return res.status(201).json({ success: true, session });
      } else if (action === "heartbeat") {
        await this.sessionModel.updateSessionActivity(sessionId);
        return res.status(200).json({ success: true });
      } else if (action === "end") {
        const session = await this.sessionModel.endSession(sessionId);
        return res.status(200).json({ success: true, session });
      } else if (action === "recordAction") {
        await this.sessionModel.recordAction(sessionId);
        return res.status(200).json({ success: true });
      }

      return res.status(400).json({
        success: false,
        message: "Invalid action"
      });
    } catch (error) {
      console.error("Error managing session:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to manage session",
        error: process.env.NODE_ENV === "production" ? undefined : error.message
      });
    }
  }

  // POST /api/analytics/pageview - Log page view
  async logPageView(req, res) {
    try {
      const userId = req.user?.id;
      const {
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
        isImpression
      } = req.body || {};

      if (!pagePath) {
        return res.status(400).json({
          success: false,
          message: "pagePath is required"
        });
      }

      const pageView = await this.pageViewModel.logPageView({
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
        isImpression: isImpression || false
      });

      // Update session page count
      if (sessionId) {
        await this.sessionModel.updateSessionActivity(sessionId);
      }

      return res.status(201).json({
        success: true,
        pageView
      });
    } catch (error) {
      console.error("Error logging page view:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to log page view",
        error: process.env.NODE_ENV === "production" ? undefined : error.message
      });
    }
  }

  // PUT /api/analytics/pageview/:id/engagement - Update engagement metrics
  async updatePageEngagement(req, res) {
    try {
      const { id } = req.params;
      const { timeOnPage, scrollDepth, clickCount, formFills } = req.body || {};

      const pageView = await this.pageViewModel.updatePageEngagement(parseInt(id), {
        timeOnPage,
        scrollDepth,
        clickCount,
        formFills
      });

      return res.status(200).json({
        success: true,
        pageView
      });
    } catch (error) {
      console.error("Error updating page engagement:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to update page engagement",
        error: process.env.NODE_ENV === "production" ? undefined : error.message
      });
    }
  }

  // POST /api/analytics/field-change - Log field change
  async logFieldChange(req, res) {
    try {
      const userId = req.user?.id;
      const userName = req.user?.name || req.user?.fullName || req.user?.email || null;
      
      const {
        entityType,
        entityId,
        entityLabel,
        fieldName,
        fieldLabel,
        oldValue,
        newValue,
        changeType,
        changeReason,
        metadata
      } = req.body || {};

      if (!entityType || !entityId || !fieldName) {
        return res.status(400).json({
          success: false,
          message: "entityType, entityId, and fieldName are required"
        });
      }

      const change = await this.fieldChangeModel.logFieldChange({
        userId,
        userName,
        entityType,
        entityId,
        entityLabel,
        fieldName,
        fieldLabel,
        oldValue,
        newValue,
        changeType: changeType || "update",
        changeReason,
        metadata
      });

      return res.status(201).json({
        success: true,
        change
      });
    } catch (error) {
      console.error("Error logging field change:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to log field change",
        error: process.env.NODE_ENV === "production" ? undefined : error.message
      });
    }
  }

  // GET /api/analytics/sessions - Get sessions list
  async getSessions(req, res) {
    try {
      const { userId, start, startDate, end, endDate, page = "1", limit = "50" } = req.query;
      
      const resolvedStart = start || startDate || null;
      const resolvedEnd = end || endDate || null;
      
      const numericLimit = Math.min(parseInt(limit, 10) || 50, 100);
      const numericPage = Math.max(parseInt(page, 10) || 1, 1);
      const offset = (numericPage - 1) * numericLimit;

      const result = await this.sessionModel.getSessions({
        userId: userId || null,
        startDate: resolvedStart,
        endDate: resolvedEnd,
        limit: numericLimit,
        offset
      });

      return res.status(200).json({
        success: true,
        ...result,
        page: numericPage,
        pageSize: numericLimit
      });
    } catch (error) {
      console.error("Error fetching sessions:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch sessions",
        error: process.env.NODE_ENV === "production" ? undefined : error.message
      });
    }
  }

  // GET /api/analytics/pageviews - Get page views list
  async getPageViews(req, res) {
    try {
      const { userId, sessionId, pagePath, start, startDate, end, endDate, page = "1", limit = "50" } = req.query;
      
      const resolvedStart = start || startDate || null;
      const resolvedEnd = end || endDate || null;
      
      const numericLimit = Math.min(parseInt(limit, 10) || 50, 100);
      const numericPage = Math.max(parseInt(page, 10) || 1, 1);
      const offset = (numericPage - 1) * numericLimit;

      const result = await this.pageViewModel.getPageViews({
        userId: userId || null,
        sessionId: sessionId || null,
        pagePath: pagePath || null,
        startDate: resolvedStart,
        endDate: resolvedEnd,
        limit: numericLimit,
        offset
      });

      return res.status(200).json({
        success: true,
        ...result,
        page: numericPage,
        pageSize: numericLimit
      });
    } catch (error) {
      console.error("Error fetching page views:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch page views",
        error: process.env.NODE_ENV === "production" ? undefined : error.message
      });
    }
  }

  // GET /api/analytics/field-changes - Get field changes list
  async getFieldChanges(req, res) {
    try {
      const { userId, entityType, entityId, fieldName, start, startDate, end, endDate, page = "1", limit = "50" } = req.query;
      
      const resolvedStart = start || startDate || null;
      const resolvedEnd = end || endDate || null;
      
      const numericLimit = Math.min(parseInt(limit, 10) || 50, 100);
      const numericPage = Math.max(parseInt(page, 10) || 1, 1);
      const offset = (numericPage - 1) * numericLimit;

      const result = await this.fieldChangeModel.getFieldChanges({
        userId: userId || null,
        entityType: entityType || null,
        entityId: entityId || null,
        fieldName: fieldName || null,
        startDate: resolvedStart,
        endDate: resolvedEnd,
        limit: numericLimit,
        offset
      });

      return res.status(200).json({
        success: true,
        ...result,
        page: numericPage,
        pageSize: numericLimit
      });
    } catch (error) {
      console.error("Error fetching field changes:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch field changes",
        error: process.env.NODE_ENV === "production" ? undefined : error.message
      });
    }
  }

  // GET /api/analytics/users/:userId/activity - Get detailed user activity
  async getUserActivity(req, res) {
    try {
      const { userId } = req.params;
      const { start, startDate, end, endDate, page = "1", limit = "50" } = req.query;
      
      const resolvedStart = start || startDate || null;
      const resolvedEnd = end || endDate || null;
      
      const numericLimit = Math.min(parseInt(limit, 10) || 50, 100);
      const numericPage = Math.max(parseInt(page, 10) || 1, 1);
      const offset = (numericPage - 1) * numericLimit;

      // Get user sessions
      const sessions = await this.sessionModel.getSessions({
        userId: parseInt(userId),
        startDate: resolvedStart,
        endDate: resolvedEnd,
        limit: 10,
        offset: 0
      });

      // Get user page views
      const pageViews = await this.pageViewModel.getPageViews({
        userId: parseInt(userId),
        startDate: resolvedStart,
        endDate: resolvedEnd,
        limit: numericLimit,
        offset
      });

      // Get user field changes
      const fieldChanges = await this.fieldChangeModel.getFieldChanges({
        userId: parseInt(userId),
        startDate: resolvedStart,
        endDate: resolvedEnd,
        limit: numericLimit,
        offset
      });

      // Get user activities
      const { activities, total } = await this.activityLogModel.getActivities({
        userId: parseInt(userId),
        startDate: resolvedStart,
        endDate: resolvedEnd,
        limit: numericLimit,
        offset
      });

      return res.status(200).json({
        success: true,
        sessions: sessions.sessions,
        pageViews: pageViews.pageViews,
        fieldChanges: fieldChanges.changes,
        activities,
        total,
        page: numericPage,
        pageSize: numericLimit
      });
    } catch (error) {
      console.error("Error fetching user activity:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch user activity",
        error: process.env.NODE_ENV === "production" ? undefined : error.message
      });
    }
  }
}

module.exports = AnalyticsController;
