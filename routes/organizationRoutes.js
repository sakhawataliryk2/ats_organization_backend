// Updated routes/organizationRoutes.js
const express = require('express');

function createOrganizationRouter(organizationController, authMiddleware) {
    const router = express.Router();
    const { verifyToken, checkRole } = authMiddleware;

    // All routes require authentication
    router.use(verifyToken);

    // Get all organizations 
    // (admins see all, regular users see only their own)
    router.get('/', organizationController.getAll);

    // Get organizations that have at least one placement with status = 'Approved' (for TBI)
    router.get('/with-approved-placements', organizationController.getWithApprovedPlacements);

    // Get dependency counts for an organization (must be before /:id route)
    router.get('/:id/dependencies', organizationController.getDependencies);

    // Get organization by ID 
    // (admins can see any, regular users only their own)
    router.get('/:id', organizationController.getById);

    // Create new organization
    router.post('/', organizationController.create);

    // Bulk update organizations
    router.post('/bulk-update', organizationController.bulkUpdate);

    // Update organization by ID 
    // (admins can update any, regular users only their own)
    router.put('/:id', organizationController.update);

    // Delete organization by ID 
    // (admins can delete any, regular users only their own)
    router.delete('/:id', organizationController.delete);

    // New routes for notes
    router.post('/:id/notes', organizationController.addNote);
    router.get('/:id/notes', organizationController.getNotes);

    // New route for history
    router.get('/:id/history', organizationController.getHistory);

    // Document routes
    router.get('/:id/documents', organizationController.getDocuments);
    // Upload organization document (JSON body with base64 file data, no multer)
    router.post('/:id/documents/upload', organizationController.uploadDocument);
    router.post('/:id/documents', organizationController.addDocument);
    router.get('/:id/documents/:documentId', organizationController.getDocument);
    router.put('/:id/documents/:documentId', organizationController.updateDocument);
    router.delete('/:id/documents/:documentId', organizationController.deleteDocument);

    // Summary counts route
    router.get('/:id/summary-counts', organizationController.getSummaryCounts);

    return router;
}

// Transfer routes - separate router
function createTransferRouter(transferController, authMiddleware) {
    const router = express.Router();
    const { verifyToken } = authMiddleware;

    // All routes require authentication
    router.use(verifyToken);

    // Create transfer request
    router.post('/', transferController.create);

    // Approve transfer
    router.post('/:id/approve', transferController.approve);

    // Deny transfer
    router.post('/:id/deny', transferController.deny);

    return router;
}

// Delete request routes - separate router
function createDeleteRequestRouter(deleteRequestController, authMiddleware) {
    const router = express.Router();
    const { verifyToken } = authMiddleware;

    // All routes require authentication
    router.use(verifyToken);

    // Get delete request by ID (for approval/deny pages)
    router.get('/delete/:id', deleteRequestController.getById);

    // Get delete request for a record
    router.get('/:id/delete-request', deleteRequestController.getByRecord);

    // Create delete request
    router.post('/:id/delete-request', deleteRequestController.create);

    // Unarchive request (sends email to Payroll or Onboarding for job seekers)
    router.post('/:id/unarchive-request', deleteRequestController.sendUnarchiveRequest);

    // Approve delete request (must come before /:id routes)
    router.post('/delete/:id/approve', deleteRequestController.approve);

    // Deny delete request (must come before /:id routes)
    router.post('/delete/:id/deny', deleteRequestController.deny);

    return router;
}

module.exports = { createOrganizationRouter, createTransferRouter, createDeleteRequestRouter };