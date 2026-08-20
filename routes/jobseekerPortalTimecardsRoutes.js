// routes/jobseekerPortalTimecardsRoutes.js
// Mount at /api/jobseeker-portal so paths are /api/jobseeker-portal/timecards, etc.

const express = require("express");
const JobseekerPortalAuthController = require("../controllers/jobseekerPortalAuthController");
const jobseekerPortalTimecardsController = require("../controllers/jobseekerPortalTimecardsController");

module.exports = function jobseekerPortalTimecardsRoutes(pool) {
  const router = express.Router();
  const portal = new JobseekerPortalAuthController(pool);
  const ctrl = jobseekerPortalTimecardsController(pool);
  const auth = portal.portalAuth.bind(portal);

  router.get("/timecards/access", auth, ctrl.access.bind(ctrl));
  router.get("/timecards/placements", auth, ctrl.placements.bind(ctrl));
  router.get("/timecards", auth, ctrl.list.bind(ctrl));
  router.get("/timecards/:id", auth, ctrl.getById.bind(ctrl));
  router.post("/timecards", auth, ctrl.create.bind(ctrl));
  router.put("/timecards/:id", auth, ctrl.update.bind(ctrl));
  router.post("/timecards/:id/submit", auth, ctrl.submit.bind(ctrl));

  return router;
};
