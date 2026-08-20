// routes/tearsheetRoutes.js
const express = require("express");

function createTearsheetRouter(tearsheetController, authMiddleware) {
  const router = express.Router();
  const { verifyToken } = authMiddleware;

  // All routes require authentication
  router.use(verifyToken);

  router.get("/", tearsheetController.getAll);
  router.get("/organization/:organizationId", tearsheetController.getTearsheetsByOrganizationId);
  router.get("/job/:jobId", tearsheetController.getTearsheetsByJobId);
  router.get("/lead/:leadId", tearsheetController.getTearsheetsByLeadId);
  router.get("/hiring-manager/:hiringManagerId", tearsheetController.getTearsheetsByHiringManagerId);
  router.get("/job-seeker/:jobSeekerId", tearsheetController.getTearsheetsByJobSeekerId);
  router.get("/task/:taskId", tearsheetController.getTearsheetsByTaskId);
  router.get("/:id", tearsheetController.getById);
  router.get("/:id/records", tearsheetController.getRecords);
  router.get("/:id/organizations", tearsheetController.getOrganizations);
  router.get("/:id/placements", tearsheetController.getPlacements);
  router.post("/", tearsheetController.create);
  router.post("/:id/associate", tearsheetController.associate);
  router.delete("/:id", tearsheetController.delete);

  return router;
}

module.exports = createTearsheetRouter;


