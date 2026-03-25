const express = require('express');
function createHiringManagerRouter(hiringManagerController, authMiddleware) {
    const router = express.Router();
    const { verifyToken, checkRole } = authMiddleware;

    // All routes require authentication
    router.use(verifyToken);

    // Get all hiring managers 
    // (admins see all, regular users see only their own)
    router.get('/', hiringManagerController.getAll);

    // Get hiring managers by organization ID
    // Must be before /:id route to avoid matching "organization" as an ID
    router.get('/organization/:organizationId', hiringManagerController.getByOrganization);

    // Get hiring manager by ID 
    // (admins can see any, regular users only their own)
    router.get('/:id', hiringManagerController.getById);

    // Create new hiring manager
    router.post('/', hiringManagerController.create);

    // Update hiring manager by ID 
    // (admins can update any, regular users only their own)
    router.put('/:id', hiringManagerController.update);

    // Bulk update hiring managers
    router.post('/bulk-update', hiringManagerController.bulkUpdate);

    // Delete hiring manager by ID 
    // (admins can delete any, regular users only their own)
    router.delete('/:id', hiringManagerController.delete);

    // Routes for notes
    router.post('/:id/notes', hiringManagerController.addNote);
    router.get('/:id/notes', hiringManagerController.getNotes);

    // History route
    router.get('/:id/history', hiringManagerController.getHistory);

    // Document routes
    router.get('/:id/documents', hiringManagerController.getDocuments);
    router.post('/:id/documents/upload', hiringManagerController.uploadDocument);
    router.post('/:id/documents', hiringManagerController.addDocument);
    router.get('/:id/documents/:documentId', hiringManagerController.getDocument);
    router.put('/:id/documents/:documentId', hiringManagerController.updateDocument);
    router.delete('/:id/documents/:documentId', hiringManagerController.deleteDocument);

    // Routes for delete requests
    const deleteRequestController = hiringManagerController.deleteRequestController;
    if (deleteRequestController) {
        router.get('/:id/delete-request', deleteRequestController.getByRecord);
        router.post('/:id/delete-request', deleteRequestController.create);
    }

    return router;
}

module.exports = createHiringManagerRouter;