// Vercel serverless cron: archive cleanup (runs daily at 2 AM).
const { getPool } = require("../../config/getPool");
const { runArchiveCleanup } = require("../../jobs/archiveCleanup");

async function handler(req, res) {
  // if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ error: "Unauthorized" });
  // }

  try {
    const pool = getPool();
    console.log("Archive cleanup started");
    await runArchiveCleanup(pool);
    console.log("Archive cleanup completed");
    return res.status(200).json({ success: true, message: "Archive cleanup completed" });
  } catch (error) {
    console.error("Error running archive cleanup job:", error);
    return res.status(500).json({
      success: false,
      error: "Archive cleanup failed",
      message: process.env.NODE_ENV === "production" ? undefined : error.message,
    });
  }
}

module.exports = handler;
