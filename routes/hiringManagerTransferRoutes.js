// routes/hiringManagerTransferRoutes.js
const express = require("express");

function createHiringManagerTransferRouter(controller, authMiddleware) {
  const router = express.Router();
  const { verifyToken } = authMiddleware;

  router.use(verifyToken);

  router.post("/", controller.create);
  router.get("/:id", controller.getById);
  router.post("/:id/approve", controller.approve);
  router.post("/:id/deny", controller.deny);

  return router;
}

module.exports = createHiringManagerTransferRouter;
