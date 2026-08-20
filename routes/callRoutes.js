/**
 * Click-to-call routes - POST /api/calls/start
 */

const express = require('express');

function createCallRouter(callController, authMiddleware) {
  const router = express.Router();
  const { verifyToken } = authMiddleware;

  router.use(verifyToken);
  router.post('/start', (req, res) => callController.startCall(req, res));

  return router;
}

module.exports = { createCallRouter };
