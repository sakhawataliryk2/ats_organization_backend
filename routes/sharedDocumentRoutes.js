// routes/sharedDocumentRoutes.js
const express = require("express");

function createSharedDocumentRouter(sharedDocumentController, authMiddleware) {
  const router = express.Router();
  const { verifyToken } = authMiddleware;

  // All routes require authentication
  router.use(verifyToken);

  router.get("/", sharedDocumentController.getAll);
  router.get("/:id", sharedDocumentController.getById);
  router.post("/", sharedDocumentController.create);
  router.delete("/:id", sharedDocumentController.delete);

  return router;
}

module.exports = createSharedDocumentRouter;

