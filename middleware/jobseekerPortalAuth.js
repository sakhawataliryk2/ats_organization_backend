// middleware/jobseekerPortalAuth.js
const jwt = require("jsonwebtoken");

function jobseekerPortalAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;

    if (!token) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const decoded = jwt.verify(token, process.env.JOBSEEKER_PORTAL_JWT_SECRET);
    // decoded = { portal_user: true, job_seeker_id, email, ... }
    req.portalUser = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: "Invalid token" });
  }
}

module.exports = jobseekerPortalAuth;
