const express = require("express");

function createActivityRouter(activityController, authMiddleware) {
  const router = express.Router();
  const { verifyToken, checkRole } = authMiddleware;

  // All activity routes require authentication
  router.use(verifyToken);

  // Public (to any authenticated user) logging endpoint
  router.post("/", activityController.logActivity);

  // Activity report for dashboard (any authenticated user; typically own userId)
  router.get("/report", activityController.getReport);

  // Admin-only endpoints for reading activity
  router.get(
    "/admin",
    checkRole("admin", "owner"),
    activityController.getActivities
  );

  router.get(
    "/admin/summary",
    checkRole("admin", "owner"),
    activityController.getSummary
  );

  return router;
}

module.exports = createActivityRouter;

