const express = require("express");

function createZoomPhoneRouter(zoomPhoneController, authMiddleware) {
  const router = express.Router();
  const { verifyToken } = authMiddleware;

  router.use(verifyToken);

  router.post("/call", zoomPhoneController.startCall);

  return router;
}

function createZoomPhoneWebhookRouter(zoomPhoneController) {
  const router = express.Router();

  router.post("/phone", (req, res) => {
    zoomPhoneController.handleWebhook(req, res);
  });

  return router;
}

module.exports = { createZoomPhoneRouter, createZoomPhoneWebhookRouter };

