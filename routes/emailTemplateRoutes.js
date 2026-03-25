const express = require('express');
const EmailTemplateController = require('../controllers/emailTemplateController');

function createEmailTemplateRouter(pool) {
  const router = express.Router();
  const controller = new EmailTemplateController(pool);

  // Routes for email templates using ID
  router.post('/templates', controller.createTemplate);               // Create new
  router.get('/templates', controller.listTemplates);                 // List all
  router.get('/templates/:id', controller.getTemplateById);          // Get by ID
  router.put('/templates/:id', controller.updateTemplateById);       // Update by ID
  router.delete('/templates/:id', controller.deleteTemplateById);    // Delete by ID

  return router;
}

module.exports = createEmailTemplateRouter;