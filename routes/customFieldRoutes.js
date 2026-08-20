const express = require('express');

function createCustomFieldRouter(customFieldController, authMiddleware) {
    const router = express.Router();
    const { verifyToken, checkRole } = authMiddleware;

    // All routes require authentication
    router.use(verifyToken);

    // Get all custom fields for an entity type
    router.get('/entity/:entityType', customFieldController.getByEntityType);

    // Get custom field by ID
    router.get('/:id', customFieldController.getById);

    // Get history for a custom field
    router.get('/:id/history', customFieldController.getHistory);

    // Create new custom field (admin/owner only)
    router.post('/', checkRole('admin', 'owner'), customFieldController.create);

    // Update custom field by ID (admin/owner only)
    router.put('/:id', checkRole('admin', 'owner'), customFieldController.update);

    // Delete custom field by ID (admin/owner only)
    router.delete('/:id', checkRole('admin', 'owner'), customFieldController.delete);

    return router;
}

module.exports = createCustomFieldRouter;