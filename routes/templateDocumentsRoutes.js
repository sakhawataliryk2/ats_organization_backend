const express = require("express");

module.exports = (pool, authMiddleware) => {
  const router = express.Router();
  const { verifyToken } = authMiddleware;

  router.use(verifyToken);

  const TemplateDocumentController = require("../controllers/templateDocumentController");
  const controller = new TemplateDocumentController(pool);

  controller.initTables().catch(console.error);

  router.get("/", controller.getAll);
  router.get("/:id", controller.getById);

  router.post("/", express.json({ limit: "30mb" }), controller.create);
  router.put("/:id", express.json({ limit: "30mb" }), controller.update);

  router.patch("/:id/archive", express.json(), controller.archive);

  router.delete("/:id", controller.delete);

  router.get("/:id/mappings", controller.getMappings);
  router.put("/:id/mappings", express.json(), controller.saveMappings);

  return router;
};
      