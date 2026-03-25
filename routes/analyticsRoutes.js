const express = require("express");

function createAnalyticsRouter(analyticsController, authMiddleware) {
  const router = express.Router();
  const { verifyToken, checkRole } = authMiddleware;

  // All analytics routes require authentication
  router.use(verifyToken);

  // Dashboard stats (admin/owner only)
  router.get(
    "/dashboard",
    checkRole("admin", "owner"),
    analyticsController.getDashboardStats
  );

  // Session management
  router.post("/session", analyticsController.manageSession);

  // Page view tracking
  router.post("/pageview", analyticsController.logPageView);
  router.put("/pageview/:id/engagement", analyticsController.updatePageEngagement);

  // Field change tracking
  router.post("/field-change", analyticsController.logFieldChange);

  // Data retrieval routes (admin/owner only)
  router.get(
    "/sessions",
    checkRole("admin", "owner"),
    analyticsController.getSessions
  );

  router.get(
    "/pageviews",
    checkRole("admin", "owner"),
    analyticsController.getPageViews
  );

  router.get(
    "/field-changes",
    checkRole("admin", "owner"),
    analyticsController.getFieldChanges
  );

  // User activity detail (admin/owner only)
  router.get(
    "/users/:userId/activity",
    checkRole("admin", "owner"),
    analyticsController.getUserActivity
  );

  return router;
}

module.exports = createAnalyticsRouter;
