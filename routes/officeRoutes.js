const express = require('express');

function createOfficeRouter(officeController, authMiddleware) {
    const router = express.Router();
    const { verifyToken, checkRole } = authMiddleware;

    // All routes require authentication
    router.use(verifyToken);

    // Get all offices
    router.get('/', officeController.getAllOffices);

    // Create new office
    router.post('/', checkRole('admin', 'owner'), officeController.createOffice);

    // Update office
    router.put('/:id', checkRole('admin', 'owner'), officeController.updateOffice);

    // Delete office
    router.delete('/:id', checkRole('admin', 'owner'), officeController.deleteOffice);

    return router;
}

module.exports = createOfficeRouter;