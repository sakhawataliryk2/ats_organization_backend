const express = require('express');
function createJobSeekerRouter(jobSeekerController, authMiddleware, clientSubmissionController) {

    const router = express.Router();

    const { verifyToken, checkRole } = authMiddleware;



    // All routes require authentication

    router.use(verifyToken);



    // Candidate flow dashboard stats (must be before /:id)
    router.get('/candidate-flow', jobSeekerController.getCandidateFlowStats);

    // Applications board for Sales Dashboard Kanban (must be before /:id)
    router.get('/applications/board', jobSeekerController.getApplicationsBoard);

    // Real-time duplicate detection for Add Job Seeker (email / phone)
    router.get('/check-duplicates', jobSeekerController.checkDuplicates);

    // Get all job seekers 

    // (admins see all, regular users see only their own)

    router.get('/', jobSeekerController.getAll);



    // Get job seeker by ID 

    // (admins can see any, regular users only their own)

    router.get('/:id', jobSeekerController.getById);



    // Create new job seeker

    router.post('/', jobSeekerController.create);



    // Update job seeker by ID 

    // (admins can update any, regular users only their own)

    router.put('/:id', jobSeekerController.update);

    // Bulk update job seekers (must be before /:id route)
    router.post('/bulk-update', jobSeekerController.bulkUpdate);

    // Delete job seeker by ID 

    // (admins can delete any, regular users only their own)

    router.delete('/:id', jobSeekerController.delete);



    // Routes for notes

    router.post('/:id/notes', jobSeekerController.addNote);

    router.get('/:id/notes', jobSeekerController.getNotes);



    // Route for history

    router.get('/:id/history', jobSeekerController.getHistory);



    // Document routes

    router.get('/:id/documents', jobSeekerController.getDocuments);

    router.post('/:id/documents/upload', jobSeekerController.uploadDocument);

    router.post('/:id/documents', jobSeekerController.addDocument);

    router.get('/:id/documents/:documentId', jobSeekerController.getDocument);

    router.put('/:id/documents/:documentId', jobSeekerController.updateDocument);

    router.delete('/:id/documents/:documentId', jobSeekerController.deleteDocument);


    
    // Routes for references

    router.get('/:id/references', jobSeekerController.getReferences);

    router.post('/:id/references', jobSeekerController.addReference);

    router.delete('/:id/references/:referenceId', jobSeekerController.deleteReference);


    
    // Routes for applications
    router.get('/:id/applications', jobSeekerController.getApplications);
    router.post('/:id/applications', jobSeekerController.addApplication);
    router.patch('/:id/applications/:applicationId', jobSeekerController.updateApplication);

    // Routes for client submissions (separate table)
    if (clientSubmissionController) {
        router.get('/:id/client-submissions', clientSubmissionController.getByJobSeeker);
        router.post('/:id/client-submissions', clientSubmissionController.createForJobSeeker);
    }

    return router;
}

// Delete request routes for job seekers - same structure as tasks/jobs for consistent behavior
function createJobSeekerDeleteRequestRouter(deleteRequestController, authMiddleware) {
    const router = express.Router();
    const { verifyToken } = authMiddleware;

    router.use(verifyToken);

    router.get('/delete/:id', deleteRequestController.getById);
    router.get('/:id/delete-request', deleteRequestController.getByRecord);
    router.post('/:id/delete-request', deleteRequestController.create);
    router.post('/:id/unarchive-request', deleteRequestController.sendUnarchiveRequest);
    router.post('/delete/:id/approve', deleteRequestController.approve);
    router.post('/delete/:id/deny', deleteRequestController.deny);

    return router;
}

module.exports = createJobSeekerRouter;
module.exports.createJobSeekerDeleteRequestRouter = createJobSeekerDeleteRequestRouter;