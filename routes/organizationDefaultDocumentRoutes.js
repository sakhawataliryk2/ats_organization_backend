const express = require("express");

module.exports = (pool, authMiddleware) => {
  const router = express.Router();
  const { verifyToken } = authMiddleware;

  router.use(verifyToken);

  const OrganizationDefaultDocumentController = require("../controllers/organizationDefaultDocumentController");
  const controller = new OrganizationDefaultDocumentController(pool);

  controller.initTable().catch(console.error);

  router.get("/", controller.getAll);
  router.get("/welcome", (req, res) => {
    req.params.slot = "welcome";
    return controller.getBySlot(req, res);
  });
  router.put("/welcome", express.json(), controller.setWelcome);
  router.post("/welcome/upload", express.json({ limit: "30mb" }), controller.setWelcomeUpload);
  router.post("/welcome/push-to-all", controller.pushToAllOrganizations);

  return router;
};
