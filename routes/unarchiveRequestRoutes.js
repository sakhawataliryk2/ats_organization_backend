const express = require("express");

function createUnarchiveRequestRouter(deleteRequestController, authMiddleware) {
  const router = express.Router();
  const { verifyToken } = authMiddleware;

  router.use(verifyToken);

  router.get("/:id", deleteRequestController.getUnarchiveRequestById);
  router.post("/:id/approve", deleteRequestController.approveUnarchive);
  router.post("/:id/deny", deleteRequestController.denyUnarchive);

  return router;
}

module.exports = { createUnarchiveRequestRouter };
