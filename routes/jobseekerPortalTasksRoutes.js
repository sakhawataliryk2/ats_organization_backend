// routes/jobseekerPortalTasksRoutes.js
// Mount at /api/jobseeker-portal so paths are /api/jobseeker-portal/tasks, etc.

const express = require("express");
const JobseekerPortalAuthController = require("../controllers/jobseekerPortalAuthController");
const jobseekerPortalTasksController = require("../controllers/jobseekerPortalTasksController");

module.exports = function jobseekerPortalTasksRoutes(pool) {
  const router = express.Router();
  const portal = new JobseekerPortalAuthController(pool);
  const ctrl = jobseekerPortalTasksController(pool);
  const auth = portal.portalAuth.bind(portal);

  router.get("/tasks", auth, ctrl.list.bind(ctrl));
  router.get("/tasks/:id", auth, ctrl.getById.bind(ctrl));
  router.post("/tasks/:id/complete", auth, ctrl.complete.bind(ctrl));

  return router;
};

