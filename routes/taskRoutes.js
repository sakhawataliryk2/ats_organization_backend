const express = require('express');

function createTaskRouter(taskController, authMiddleware) {
    const router = express.Router();
    const { verifyToken, checkRole } = authMiddleware;

    // All routes require authentication
    router.use(verifyToken);

    // Get all tasks 
    // (admins see all, regular users see only their own or assigned to them)
    router.get('/', taskController.getAll);

    // Process reminders (call via cron or manually) - sends email to owner and assigned_to
    router.get('/process-reminders', taskController.processReminders);

    // Diagnostic endpoint to check why tasks aren't matching reminder criteria
    router.get('/diagnose-reminders', taskController.diagnoseReminders);

    // Get task by ID 
    // (admins can see any, regular users only their own or assigned to them)
    router.get('/:id', taskController.getById);

    // Create new task
    router.post('/', taskController.create);

    // Update task by ID 
    // (admins can update any, regular users only their own or assigned to them)
    router.put('/:id', taskController.update);

    // Bulk update tasks (must be before /:id route)
    router.post('/bulk-update', taskController.bulkUpdate);

    // Delete task by ID 
    // (admins can delete any, regular users only their own)
    router.delete('/:id', taskController.delete);

    // Routes for notes
    router.post('/:id/notes', taskController.addNote);
    router.get('/:id/notes', taskController.getNotes);

    // Route for history
    router.get('/:id/history', taskController.getHistory);

    // Task-specific routes
    router.get('/stats/overview', taskController.getStats);
    router.put('/:id/complete', taskController.markComplete);
    router.put('/:id/incomplete', taskController.markIncomplete);

    return router;
}

// Delete request routes for tasks - separate router
function createTaskDeleteRequestRouter(deleteRequestController, authMiddleware) {
    const router = express.Router();
    const { verifyToken } = authMiddleware;

    // All routes require authentication
    router.use(verifyToken);

    // Get delete request by ID (for approval/deny pages)
    router.get('/delete/:id', deleteRequestController.getById);

    // Get delete request for a task
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

module.exports = { createTaskRouter, createTaskDeleteRequestRouter };