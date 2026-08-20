// routes/adminDocumentRoutes.js
const express = require("express");

function createAdminDocumentRouter(adminDocumentController, authMiddleware) {
  const router = express.Router();
  const { verifyToken } = authMiddleware;

  // All routes require authentication
  router.use(verifyToken);

  router.get("/", adminDocumentController.getAll);
  router.get("/categories", adminDocumentController.getCategories);
  router.get("/:id", adminDocumentController.getById);
  router.post("/", adminDocumentController.create);
  router.put("/:id", adminDocumentController.update);
  router.delete("/:id", adminDocumentController.delete);

  return router;
}

module.exports = createAdminDocumentRouter;

