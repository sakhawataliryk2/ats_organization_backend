// routes/placementRoutes.js
const express = require('express');
function createPlacementRouter(placementController, authMiddleware) {
    const router = express.Router();
    const { verifyToken, checkRole } = authMiddleware;

    // All routes require authentication
    router.use(verifyToken);

    // Get all placements
    // (admins see all, regular users see only their own)
    router.get('/', placementController.getAll);

    // Get placements by job ID
    router.get('/job/:jobId', placementController.getByJobId);

    // Get placements by job seeker ID
    router.get('/job-seeker/:jobSeekerId', placementController.getByJobSeekerId);

    // Get placements by organization ID
    router.get('/organization/:organizationId', placementController.getByOrganizationId);

    // Get placement history (must be before /:id - more specific route first)
    router.get('/:id/history', placementController.getHistory);

    // Notes (must be before /:id)
    router.get('/:id/notes', placementController.getNotes);
    router.post('/:id/notes', placementController.addNote);

    // Get placement by ID
    // (admins can see any, regular users only their own)
    router.get('/:id', placementController.getById);

    // Create new placement
    router.post('/', placementController.create);

    // Update placement by ID
    // (admins can update any, regular users only their own)
    router.put('/:id', placementController.update);

    // Bulk update placements (must be before /:id route)
    router.post('/bulk-update', placementController.bulkUpdate);

    // Delete placement by ID
    // (admins can delete any, regular users only their own)
    router.delete('/:id', placementController.delete);

    // Document routes
    router.get('/:id/documents', placementController.getDocuments);
    router.post('/:id/documents/upload', placementController.uploadDocument);
    router.post('/:id/documents', placementController.addDocument);
    router.get('/:id/documents/:documentId', placementController.getDocument);
    router.put('/:id/documents/:documentId', placementController.updateDocument);
    router.delete('/:id/documents/:documentId', placementController.deleteDocument);

    return router;
}

// Delete request routes for placements - separate router
function createPlacementDeleteRequestRouter(deleteRequestController, authMiddleware) {
    const router = express.Router();
    const { verifyToken } = authMiddleware;

    // All routes require authentication
    router.use(verifyToken);

    // Get delete request by ID (for approval/deny pages)
    router.get('/delete/:id', deleteRequestController.getById);

    // Get delete request for a placement
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

module.exports = { createPlacementRouter, createPlacementDeleteRequestRouter };

