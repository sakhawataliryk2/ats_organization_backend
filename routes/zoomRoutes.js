/**
 * Zoom Phone API routes: phone users, numbers, call logs.
 * All routes require authentication.
 */

const express = require('express');
const zoomPhone = require('../services/zoomPhone');

function createZoomRouter(authMiddleware) {
  const router = express.Router();
  const { verifyToken } = authMiddleware;

  router.use(verifyToken);

  router.get('/phone-users', async (req, res) => {
    try {
      const data = await zoomPhone.getPhoneUsers();
      return res.json(data);
    } catch (err) {
      console.error('Error fetching Zoom phone users:', err);
      const status = err.response?.status || 500;
      const message = err.response?.data?.message || err.message;
      return res.status(status).json({ success: false, message });
    }
  });

  router.get('/phone-numbers', async (req, res) => {
    try {
      const data = await zoomPhone.getPhoneNumbers();
      return res.json(data);
    } catch (err) {
      console.error('Error fetching Zoom phone numbers:', err);
      const status = err.response?.status || 500;
      const message = err.response?.data?.message || err.message;
      return res.status(status).json({ success: false, message });
    }
  });

  router.get('/call-logs', async (req, res) => {
    try {
      const params = { ...req.query };
      const data = await zoomPhone.getCallLogs(params);
      return res.json(data);
    } catch (err) {
      console.error('Error fetching Zoom call logs:', err);
      const status = err.response?.status || 500;
      const message = err.response?.data?.message || err.message;
      return res.status(status).json({ success: false, message });
    }
  });

  return router;
}

module.exports = { createZoomRouter };
