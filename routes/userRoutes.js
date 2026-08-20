const express = require('express');

function createUserRouter(userController, authMiddleware) {
    const router = express.Router();
    const { verifyToken, checkRole } = authMiddleware;

    // All routes require authentication
    router.use(verifyToken);

    // Real-time duplicate detection for Add User (email / phone)
    router.get('/check-duplicates', userController.checkDuplicates);

    // Get all active users (for dropdowns)
    router.get('/active', userController.getActiveUsers);

    // Get all users (admin only)
    router.get('/', checkRole('admin', 'owner'), userController.getAllUsers);

    // Create new user (any authenticated user can create users)
    router.post('/', userController.createUser);

    // Update user password
    router.put('/:userId/password', checkRole('admin', 'owner'), userController.updatePassword);

    // Update user status (activate/deactivate)
    router.put('/:userId/status', checkRole('admin', 'owner'), userController.updateStatus);

    // Update user role (user type)
    router.put('/:userId/role', checkRole('admin', 'owner'), userController.updateRole);

    return router;
}

module.exports = createUserRouter;