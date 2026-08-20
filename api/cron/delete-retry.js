// Vercel serverless cron: delete request retry (runs every hour).
const { getPool } = require("../../config/getPool");
const { runDeleteRequestRetry } = require("../../jobs/deleteRequestRetry");

async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const pool = getPool();
    const result = await runDeleteRequestRetry(pool);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error("Error running delete request retry job:", error);
    return res.status(500).json({
      success: false,
      error: "Delete request retry failed",
      message: process.env.NODE_ENV === "production" ? undefined : error.message,
    });
  }
}

module.exports = handler;
