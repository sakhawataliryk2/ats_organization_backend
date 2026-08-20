const Task = require("../models/task");

function getJobSeekerId(req) {
  return req.portalUser?.job_seeker_id ?? null;
}

module.exports = function jobseekerPortalTasksController(pool) {
  const taskModel = new Task(pool);

  return {
    async list(req, res) {
      try {
        const jobSeekerId = getJobSeekerId(req);
        if (!jobSeekerId) {
          return res
            .status(401)
            .json({ success: false, message: "Unauthorized" });
        }

        const client = await pool.connect();
        try {
          const result = await client.query(
            `
              SELECT
                id,
                title,
                description,
                is_completed,
                status,
                priority,
                due_date,
                due_time,
                created_at,
                updated_at
              FROM tasks
              WHERE job_seeker_id = $1
                AND archived_at IS NULL
              ORDER BY
                COALESCE(due_date, CURRENT_DATE + INTERVAL '365 days') ASC,
                created_at DESC
            `,
            [Number(jobSeekerId)]
          );

          return res.json({
            success: true,
            tasks: result.rows,
          });
        } finally {
          client.release();
        }
      } catch (e) {
        console.error("[jobseekerPortalTasks] list", e);
        return res
          .status(500)
          .json({ success: false, message: "Server error" });
      }
    },

    async getById(req, res) {
      try {
        const jobSeekerId = getJobSeekerId(req);
        if (!jobSeekerId) {
          return res
            .status(401)
            .json({ success: false, message: "Unauthorized" });
        }

        const id = Number(req.params.id);
        if (!id) {
          return res
            .status(400)
            .json({ success: false, message: "Invalid task id" });
        }

        const task = await taskModel.getById(id, null);
        if (!task || task.job_seeker_id !== Number(jobSeekerId)) {
          return res
            .status(404)
            .json({ success: false, message: "Task not found" });
        }

        return res.json({
          success: true,
          task,
        });
      } catch (e) {
        console.error("[jobseekerPortalTasks] getById", e);
        return res
          .status(500)
          .json({ success: false, message: "Server error" });
      }
    },

    async complete(req, res) {
      try {
        const jobSeekerId = getJobSeekerId(req);
        if (!jobSeekerId) {
          return res
            .status(401)
            .json({ success: false, message: "Unauthorized" });
        }

        const id = Number(req.params.id);
        if (!id) {
          return res
            .status(400)
            .json({ success: false, message: "Invalid task id" });
        }

        const task = await taskModel.getById(id, null);
        if (!task || task.job_seeker_id !== Number(jobSeekerId)) {
          return res
            .status(404)
            .json({ success: false, message: "Task not found" });
        }

        const updated = await taskModel.update(
          id,
          {
            isCompleted: true,
            status: "Pending Approval",
          },
          null
        );

        return res.json({
          success: true,
          message: "Task marked as completed and sent for approval",
          task: updated,
        });
      } catch (e) {
        console.error("[jobseekerPortalTasks] complete", e);
        return res
          .status(500)
          .json({ success: false, message: "Server error" });
      }
    },
  };
};

