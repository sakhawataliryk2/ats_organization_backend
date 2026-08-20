const express = require("express");
const JobseekerPortalAuthController = require("../controllers/jobseekerPortalAuthController");

module.exports = function jobseekerPortalAuthRoutes(pool, authMiddleware) {
  const router = express.Router();
  const controller = new JobseekerPortalAuthController(pool);

  router.post("/login", controller.login.bind(controller));
  router.post("/forgot-password", controller.forgotPassword.bind(controller));

  // CMS admin: set job seeker portal temporary password (Bearer token required)
  if (authMiddleware && authMiddleware.verifyToken && authMiddleware.checkRole) {
    router.post(
      "/admin-set-password",
      authMiddleware.verifyToken,
      authMiddleware.checkRole("admin", "owner"),
      controller.adminSetPassword.bind(controller)
    );
  } else {
    router.post("/admin-set-password", (req, res) => {
      res.status(501).json({
        success: false,
        message: "Backend auth not configured for admin-set-password. Ensure index.js passes authMiddleware to jobseekerPortalAuthRoutes(getPool(), authMiddleware).",
      });
    });
  }

  router.get("/me", controller.portalAuth.bind(controller), controller.me.bind(controller));
  router.get("/profile", controller.portalAuth.bind(controller), controller.profile.bind(controller));
  router.put("/profile", controller.portalAuth.bind(controller), controller.updateProfile.bind(controller));
  router.post("/logout", controller.portalAuth.bind(controller), controller.logout.bind(controller));
  router.post(
    "/change-password",
    controller.portalAuth.bind(controller),
    controller.changePassword.bind(controller)
  );

  return router;
};
