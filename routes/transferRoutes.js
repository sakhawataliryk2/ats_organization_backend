// routes/transferRoutes.js
const express = require("express");

function createTransferRouter(transferController, authMiddleware) {
  const router = express.Router();
  const { verifyToken } = authMiddleware;

  // All routes require authentication
  router.use(verifyToken);

  // Create transfer request
  router.post("/", transferController.create);

  // Approve transfer
  router.post("/:id/approve", transferController.approve);

  // Deny transfer
  router.post("/:id/deny", transferController.deny);

  return router;
}

module.exports = createTransferRouter;
