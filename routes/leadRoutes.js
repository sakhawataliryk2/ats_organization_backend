const express = require('express');
function createLeadRouter(leadController, authMiddleware) {
    const router = express.Router();
    const { verifyToken, checkRole } = authMiddleware;

    // All routes require authentication
    router.use(verifyToken);

    // Get all leads 
    // (admins see all, regular users see only their own)
    router.get('/', leadController.getAll);

    // Get lead by ID 
    // (admins can see any, regular users only their own)
    router.get('/:id', leadController.getById);

    // Create new lead
    router.post('/', leadController.create);

    // Update lead by ID 
    // (admins can update any, regular users only their own)
    router.put('/:id', leadController.update);

    // Bulk update leads (must be before /:id route)
    router.post('/bulk-update', leadController.bulkUpdate);

    // Delete lead by ID 
    // (admins can delete any, regular users only their own)
    router.delete('/:id', leadController.delete);

    // Routes for notes
    router.post('/:id/notes', leadController.addNote);
    router.get('/:id/notes', leadController.getNotes);

    // Route for history
    router.get('/:id/history', leadController.getHistory);

    // Document routes (same as organization)
    router.get('/:id/documents', leadController.getDocuments);
    router.post('/:id/documents/upload', leadController.uploadDocument);
    router.post('/:id/documents', leadController.addDocument);
    router.get('/:id/documents/:documentId', leadController.getDocument);
    router.put('/:id/documents/:documentId', leadController.updateDocument);
    router.delete('/:id/documents/:documentId', leadController.deleteDocument);

    // Additional lead-specific routes
    router.get('/organization/:organizationId', leadController.getByOrganization);
    router.get('/search/query', leadController.search);
    router.get('/stats/overview', leadController.getStats);

    return router;
}

// Delete request routes for leads - separate router
function createLeadDeleteRequestRouter(deleteRequestController, authMiddleware) {
    const router = express.Router();
    const { verifyToken } = authMiddleware;

    // All routes require authentication
    router.use(verifyToken);

    // Get delete request by ID (for approval/deny pages)
    router.get('/delete/:id', deleteRequestController.getById);

    // Get delete request for a lead
    router.get('/:id/delete-request', deleteRequestController.getByRecord);

    // Create delete request
    router.post('/:id/delete-request', deleteRequestController.create);

    router.post('/:id/unarchive-request', deleteRequestController.sendUnarchiveRequest);

    // Approve delete request (must come before /:id routes)
    router.post('/delete/:id/approve', deleteRequestController.approve);

    // Deny delete request (must come before /:id routes)
    router.post('/delete/:id/deny', deleteRequestController.deny);

    return router;
}

module.exports = { createLeadRouter, createLeadDeleteRequestRouter };