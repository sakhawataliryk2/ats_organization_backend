const express = require('express');

function createTeamRouter(teamController, authMiddleware) {
    const router = express.Router();
    const { verifyToken, checkRole } = authMiddleware;

    // All routes require authentication
    router.use(verifyToken);

    // Get all teams
    router.get('/', teamController.getAllTeams);

    // Create new team
    router.post('/', checkRole('admin', 'owner'), teamController.createTeam);

    // Get team members
    router.get('/:id/members', teamController.getTeamMembers);

    // Add team member
    router.post('/:id/members', checkRole('admin', 'owner'), teamController.addTeamMember);

    // Remove team member
    router.delete('/:id/members/:userId', checkRole('admin', 'owner'), teamController.removeTeamMember);

    // Update team
    router.put('/:id', checkRole('admin', 'owner'), teamController.updateTeam);

    // Delete team
    router.delete('/:id', checkRole('admin', 'owner'), teamController.deleteTeam);

    return router;
}

module.exports = createTeamRouter;