const express = require('express');
const multer = require('multer');

function createAppointmentRouter(appointmentController, authMiddleware) {
    const router = express.Router();
    const { verifyToken, checkRole } = authMiddleware;
    const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 15 * 1024 * 1024, files: 10 }, // 15MB each, up to 10 docs
    });

    // All routes require authentication except webhook
    router.use(verifyToken);

    // Get all appointments
    router.get('/', appointmentController.getAll);

    // Get appointment by ID
    router.get('/:id', appointmentController.getById);

    // Create new appointment
    router.post('/', upload.array('documents'), appointmentController.create);

    // Update appointment by ID
    router.put('/:id', appointmentController.update);

    // Delete appointment by ID
    router.delete('/:id', appointmentController.delete);

    return router;
}

// Separate router for Zoom webhook (no authentication required, but signature verification)
function createZoomWebhookRouter(appointmentController) {
    const router = express.Router();

    // Zoom webhook endpoint (no auth middleware, uses signature verification)
    // Note: This route should be registered with express.raw() middleware before bodyParser.json()
    router.post('/webhook', (req, res) => {
        // req.body should already be parsed as JSON by bodyParser
        // For signature verification, we'll stringify it back (not ideal but works)
        // In production, register this route before bodyParser with express.raw()
        appointmentController.handleZoomWebhook(req, res);
    });

    return router;
}

module.exports = { createAppointmentRouter, createZoomWebhookRouter };
