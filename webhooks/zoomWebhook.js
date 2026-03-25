const bodyParser = require('body-parser');

function createZoomWebhookStack(getZoomPhoneController) {
  return [
    bodyParser.raw({ type: 'application/json' }),
    (req, res, next) => {
      try {
        req.rawBody = req.body ? req.body.toString() : '{}';
        req.body = JSON.parse(req.rawBody);
        next();
      } catch (e) {
        console.warn('Zoom webhook: invalid JSON body');
        return res.status(400).json({ success: false, message: 'Invalid JSON' });
      }
    },
    (req, res) => {
      console.log('Zoom webhook received');
      getZoomPhoneController().handleWebhook(req, res);
    },
  ];
}

module.exports = { createZoomWebhookStack };
