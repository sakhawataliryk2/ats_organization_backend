const express = require("express");

function createAuthRouter(authController) {
  const router = express.Router();

  // Create initial developer account (public - only works when no users exist)
  router.post("/init-developer", authController.createInitialDeveloper);

  // Signup route (protected - requires authentication)
  router.post("/signup", authController.signup);

  // Login route (step 1: email + password -> send OTP)
  router.post("/login", authController.login);

  // Verify OTP route (step 2: email + OTP -> issue JWT)
  router.post("/verify-otp", authController.verifyOtp);

  // Forgot password (send reset OTP)
  router.post("/forgot-password", authController.forgotPassword);

  // Reset password (verify OTP + set new password)
  router.post("/reset-password", authController.resetPassword);

  // Change password after first login (authenticated)
  router.post("/change-password", authController.changePassword);

  // Logout route
  router.post("/logout", authController.logout);

  return router;
}

module.exports = createAuthRouter;
