// routes/headerConfigRoutes.js
const express = require("express");

function createHeaderConfigRouter(headerConfigController, authMiddleware) {
  const router = express.Router();
  const { verifyToken } = authMiddleware;

  // All routes require authentication
  router.use(verifyToken);

  // GET /api/header-config?entityType=ORGANIZATION
  router.get("/", headerConfigController.get);

  // PUT /api/header-config?entityType=ORGANIZATION
  router.put("/", headerConfigController.upsert);

  // POST /api/header-config?entityType=ORGANIZATION (alias for PUT)
  router.post("/", headerConfigController.upsert);

  return router;
}

module.exports = createHeaderConfigRouter;

