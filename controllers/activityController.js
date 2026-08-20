const ActivityLog = require("../models/activityLog");
const User = require("../models/user");

class ActivityController {
  constructor(pool) {
    this.activityModel = new ActivityLog(pool);
    this.userModel = new User(pool);
    this.initTables = this.initTables.bind(this);
    this.logActivity = this.logActivity.bind(this);
    this.getActivities = this.getActivities.bind(this);
    this.getSummary = this.getSummary.bind(this);
    this.getReport = this.getReport.bind(this);
  }

  async initTables() {
    await this.activityModel.initTable();
  }

  // POST /api/activity
  async logActivity(req, res) {
    try {
      const userId = req.user && req.user.id;
      const userName =
        (req.user && (req.user.name || req.user.fullName || req.user.email)) ||
        null;

      const {
        action,
        entityType,
        entityId,
        entityLabel,
        metadata,
        createdAt,
      } = req.body || {};

      if (!action) {
        return res.status(400).json({
          success: false,
          message: "action is required",
        });
      }

      const activity = await this.activityModel.logActivity({
        userId,
        userName,
        action,
        entityType,
        entityId,
        entityLabel,
        metadata: metadata || null,
        createdAt: createdAt || null,
      });

      return res.status(201).json({
        success: true,
        activity,
      });
    } catch (error) {
      console.error("Error logging activity:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to log activity",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  // GET /api/admin/activity
  async getActivities(req, res) {
    try {
      const {
        userId,
        user_id,
        start,
        startDate,
        end,
        endDate,
        action,
        entityType,
        entity_type,
        page = "1",
        limit = "100",
      } = req.query;

      const resolvedUserId = userId || user_id || null;
      const resolvedStart = start || startDate || null;
      const resolvedEnd = end || endDate || null;
      const resolvedEntityType = entityType || entity_type || null;

      const numericLimit = Math.min(parseInt(limit, 10) || 100, 1000);
      const numericPage = Math.max(parseInt(page, 10) || 1, 1);
      const offset = (numericPage - 1) * numericLimit;

      const { activities, total } = await this.activityModel.getActivities({
        userId: resolvedUserId,
        startDate: resolvedStart,
        endDate: resolvedEnd,
        action: action || null,
        entityType: resolvedEntityType || null,
        limit: numericLimit,
        offset,
      });

      // Build summary (for current filters)
      const summary = await this.activityModel.getSummary({
        userId: resolvedUserId,
        startDate: resolvedStart,
        endDate: resolvedEnd,
      });

      return res.status(200).json({
        success: true,
        activities,
        total,
        page: numericPage,
        pageSize: numericLimit,
        summary,
      });
    } catch (error) {
      console.error("Error fetching activities:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch activities",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async getSummary(req, res) {
    try {
      const {
        userId,
        user_id,
        start,
        startDate,
        end,
        endDate,
      } = req.query;

      const resolvedUserId = userId || user_id || null;
      const resolvedStart = start || startDate || null;
      const resolvedEnd = end || endDate || null;

      const summary = await this.activityModel.getSummary({
        userId: resolvedUserId,
        startDate: resolvedStart,
        endDate: resolvedEnd,
      });

      return res.status(200).json({
        success: true,
        summary,
      });
    } catch (error) {
      console.error("Error fetching activity summary:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch activity summary",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  // GET /api/activity/report?userId=...&start=...&end=...
  // Returns { categories: { [key]: { notesCount, addedToSystem, ... } } } for dashboard Activity Report.
  // Uses real counts from notes tables and entity created_by/created_at.
  async getReport(req, res) {
    try {
      const { userId, user_id, start, startDate, end, endDate } = req.query;
      const resolvedUserId = userId || user_id || null;
      const resolvedStart = start || startDate || null;
      const resolvedEnd = end || endDate || null;

      if (!resolvedUserId) {
        return res.status(400).json({
          success: false,
          message: "userId is required",
        });
      }

      const result = await this.activityModel.getReportCounts({
        userId: resolvedUserId,
        startDate: resolvedStart,
        endDate: resolvedEnd,
      });

      const categories = result && result.categories ? result.categories : {
        organizations: { notesCount: 0, addedToSystem: 0, inboundEmails: 0, outboundEmails: 0, calls: 0, texts: 0 },
        jobs: { notesCount: 0, addedToSystem: 0, inboundEmails: 0, outboundEmails: 0, calls: 0, texts: 0 },
        "job-seekers": { notesCount: 0, addedToSystem: 0, inboundEmails: 0, outboundEmails: 0, calls: 0, texts: 0 },
        "hiring-managers": { notesCount: 0, addedToSystem: 0, inboundEmails: 0, outboundEmails: 0, calls: 0, texts: 0 },
        placements: { notesCount: 0, addedToSystem: 0, inboundEmails: 0, outboundEmails: 0, calls: 0, texts: 0 },
        leads: { notesCount: 0, addedToSystem: 0, inboundEmails: 0, outboundEmails: 0, calls: 0, texts: 0 },
      };

      return res.status(200).json({
        success: true,
        categories,
      });
    } catch (error) {
      console.error("Error fetching activity report:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch activity report",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }
}

module.exports = ActivityController;

