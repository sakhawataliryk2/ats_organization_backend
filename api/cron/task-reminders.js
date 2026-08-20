// Vercel serverless cron: task reminders (runs every 5 minutes).
const { getPool } = require("../../config/getPool");
const { runTaskReminders } = require("../../services/taskReminderService");

async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const pool = getPool();
    const result = await runTaskReminders(pool);
    return res.status(200).json(result);
  } catch (error) {
    console.error("Error running task reminder job:", error);
    return res.status(500).json({
      success: false,
      error: "Task reminders failed",
      message: process.env.NODE_ENV === "production" ? undefined : error.message,
    });
  }
}

module.exports = handler;
