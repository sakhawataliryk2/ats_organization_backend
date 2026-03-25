const express = require("express");

function createOnboardingRouter(onboardingController, authMiddleware) {
  const router = express.Router();
  const { verifyToken } = authMiddleware;
  
  // router.get("/debug/tables", onboardingController.listTables);
  router.use(verifyToken);

  router.post("/send", onboardingController.send);
  router.get("/job-seekers/:id", onboardingController.getForJobSeeker);
  // portal submits doc
  router.post("/items/:itemId/submit", onboardingController.submitOnboardingItem);
  router.get("/items/:itemId", onboardingController.getOnboardingItem);

  // admin actions
  router.post("/items/:itemId/admin-approve", onboardingController.adminApproveItem);
  router.post("/items/:itemId/reject", onboardingController.rejectItem);

  // cron/testing
  router.get("/reminders/run", onboardingController.runReminders);

  // timecard gate
  router.get("/job-seekers/:id/timecard-access", onboardingController.timecardAccess);
  return router;
}

module.exports = createOnboardingRouter;
