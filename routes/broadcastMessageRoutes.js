// routes/broadcastMessageRoutes.js
const express = require("express");

function createBroadcastMessageRouter(broadcastMessageController, authMiddleware) {
  const router = express.Router();
  const { verifyToken } = authMiddleware;

  // All routes require authentication
  router.use(verifyToken);

  router.get("/", broadcastMessageController.getAll);
  router.get("/:id", broadcastMessageController.getById);
  router.post("/", broadcastMessageController.create);
  router.delete("/:id", broadcastMessageController.delete);

  return router;
}

module.exports = createBroadcastMessageRouter;

