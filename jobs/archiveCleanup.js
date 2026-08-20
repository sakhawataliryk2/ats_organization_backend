
const Organization = require("../models/organization");
const Transfer = require("../models/transfer");
const { releaseRecordNumber } = require("../services/recordNumberService");

async function runArchiveCleanup(pool) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // ---------- Organizations ----------
    const archivedOrgsResult = await client.query(
      `
      SELECT DISTINCT o.id, o.name, o.record_number
      FROM organizations o
      WHERE o.status = 'Archived'
        AND o.archived_at IS NOT NULL
        AND o.archived_at <= CURRENT_TIMESTAMP - INTERVAL '7 days'
        AND o.id NOT IN (
          SELECT (task_data->>'organization_id')::integer FROM scheduled_tasks 
          WHERE task_type = 'archive_cleanup' 
          AND status = 'completed'
          AND task_data->>'organization_id' IS NOT NULL
        )
    `
    );

    const archivedOrgs = archivedOrgsResult.rows;

    for (const org of archivedOrgs) {
      console.log(`Cleaning up archived organization: ${org.name} (ID: ${org.id})`);

      await client.query(
        "DELETE FROM hiring_managers WHERE organization_id = $1",
        [org.id]
      );
      const orgJobs = await client.query(
        "SELECT id, record_number FROM jobs WHERE organization_id = $1",
        [org.id]
      );

      // Detach appointments linked to any jobs under this organization
      await client.query(
        `
        UPDATE appointments
        SET job_id = NULL
        WHERE job_id IN (
          SELECT id FROM jobs WHERE organization_id = $1
        )
      `,
        [org.id]
      );

      for (const j of orgJobs.rows) {
        if (j.record_number != null) {
          await releaseRecordNumber(client, "job", j.record_number);
        }
      }
      await client.query("DELETE FROM jobs WHERE organization_id = $1", [org.id]);
      await client.query("DELETE FROM leads WHERE organization_id = $1", [org.id]);
      await client.query(
        "DELETE FROM organization_notes WHERE organization_id = $1",
        [org.id]
      );
      await client.query(
        "DELETE FROM organization_history WHERE organization_id = $1",
        [org.id]
      );
      await client.query(
        "DELETE FROM documents WHERE entity_type = 'organization' AND entity_id = $1",
        [org.id]
      );
      if (org.record_number != null) {
        await releaseRecordNumber(client, "organization", org.record_number);
      }
      await client.query("DELETE FROM organizations WHERE id = $1", [org.id]);

      await client.query(
        `
        UPDATE scheduled_tasks
        SET status = 'completed', completed_at = CURRENT_TIMESTAMP
        WHERE task_type = 'archive_cleanup' 
          AND task_data->>'organization_id' = $1
      `,
        [org.id.toString()]
      );

      console.log(`Successfully cleaned up organization ${org.id}`);
    }

    // ---------- Hiring Managers ----------
    const archivedHmResult = await client.query(
      `
      SELECT hm.id, hm.first_name, hm.last_name, hm.record_number
      FROM hiring_managers hm
      WHERE hm.status = 'Archived'
        AND hm.archived_at IS NOT NULL
        AND hm.archived_at <= CURRENT_TIMESTAMP - INTERVAL '7 days'
      `
    );

    const archivedHms = archivedHmResult.rows;

    for (const hm of archivedHms) {
      const hmName = `${hm.last_name || ""}, ${hm.first_name || ""}`.trim() || `ID ${hm.id}`;
      console.log(`Cleaning up archived hiring manager: ${hmName} (ID: ${hm.id})`);

      if (hm.record_number != null) {
        await releaseRecordNumber(client, "hiring_manager", hm.record_number);
      }

      await client.query(
        "DELETE FROM hiring_manager_notes WHERE hiring_manager_id = $1",
        [hm.id]
      );
      await client.query(
        "DELETE FROM hiring_manager_history WHERE hiring_manager_id = $1",
        [hm.id]
      );
      await client.query(
        "DELETE FROM documents WHERE entity_type = 'hiring_manager' AND entity_id = $1",
        [hm.id]
      );
      await client.query("DELETE FROM hiring_managers WHERE id = $1", [hm.id]);

      await client.query(
        `
        UPDATE scheduled_tasks
        SET status = 'completed', completed_at = CURRENT_TIMESTAMP
        WHERE task_type = 'archive_cleanup' 
          AND task_data->>'hiring_manager_id' = $1
      `,
        [hm.id.toString()]
      );

      console.log(`Successfully cleaned up hiring manager ${hm.id}`);
    }

    // ---------- Job Seekers ----------
    const archivedJsResult = await client.query(
      `
      SELECT js.id, js.first_name, js.last_name, js.record_number
      FROM job_seekers js
      WHERE js.status = 'Archived'
        AND js.archived_at IS NOT NULL
        AND js.archived_at <= CURRENT_TIMESTAMP - INTERVAL '7 days'
      `
    );

    const archivedJs = archivedJsResult.rows;

    for (const js of archivedJs) {
      const jsName = `${js.last_name || ""}, ${js.first_name || ""}`.trim() || `ID ${js.id}`;
      console.log(`Cleaning up archived job seeker: ${jsName} (ID: ${js.id})`);

      if (js.record_number != null) {
        await releaseRecordNumber(client, "job_seeker", js.record_number);
      }

      await client.query(
        "DELETE FROM job_seeker_notes WHERE job_seeker_id = $1",
        [js.id]
      );
      await client.query(
        "DELETE FROM job_seeker_history WHERE job_seeker_id = $1",
        [js.id]
      );
      await client.query(
        "DELETE FROM documents WHERE entity_type = 'job_seeker' AND entity_id = $1",
        [js.id]
      );
      await client.query("DELETE FROM job_seekers WHERE id = $1", [js.id]);

      await client.query(
        `
        UPDATE scheduled_tasks
        SET status = 'completed', completed_at = CURRENT_TIMESTAMP
        WHERE task_type = 'archive_cleanup'
          AND task_data->>'job_seeker_id' = $1
      `,
        [js.id.toString()]
      );

      console.log(`Successfully cleaned up job seeker ${js.id}`);
    }

    // ---------- Leads ----------
    const archivedLeadsResult = await client.query(
      `
      SELECT l.id, l.first_name, l.last_name, l.record_number
      FROM leads l
      WHERE l.status = 'Archived'
        AND l.archived_at IS NOT NULL
        AND l.archived_at <= CURRENT_TIMESTAMP - INTERVAL '7 days'
      `
    );

    const archivedLeads = archivedLeadsResult.rows;

    for (const lead of archivedLeads) {
      const leadName = `${lead.last_name || ""}, ${lead.first_name || ""}`.trim() || `ID ${lead.id}`;
      console.log(`Cleaning up archived lead: ${leadName} (ID: ${lead.id})`);

      if (lead.record_number != null) {
        await releaseRecordNumber(client, "lead", lead.record_number);
      }

      await client.query(
        "DELETE FROM lead_notes WHERE lead_id = $1",
        [lead.id]
      );
      await client.query(
        "DELETE FROM lead_history WHERE lead_id = $1",
        [lead.id]
      );
      await client.query(
        "DELETE FROM documents WHERE entity_type = 'lead' AND entity_id = $1",
        [lead.id]
      );
      await client.query("DELETE FROM leads WHERE id = $1", [lead.id]);

      await client.query(
        `
        UPDATE scheduled_tasks
        SET status = 'completed', completed_at = CURRENT_TIMESTAMP
        WHERE task_type = 'archive_cleanup'
          AND task_data->>'lead_id' = $1
      `,
        [lead.id.toString()]
      );

      console.log(`Successfully cleaned up lead ${lead.id}`);
    }

    // ---------- Tasks ----------
    const archivedTasksResult = await client.query(
      `
      SELECT t.id, t.title, t.record_number
      FROM tasks t
      WHERE t.status = 'Archived'
        AND t.archived_at IS NOT NULL
        AND t.archived_at <= CURRENT_TIMESTAMP - INTERVAL '7 days'
      `
    );

    const archivedTasks = archivedTasksResult.rows;

    for (const task of archivedTasks) {
      console.log(`Cleaning up archived task: ${task.title || `ID ${task.id}`} (ID: ${task.id})`);

      await client.query(
        "DELETE FROM task_notes WHERE task_id = $1",
        [task.id]
      );
      await client.query(
        "DELETE FROM task_history WHERE task_id = $1",
        [task.id]
      );
      if (task.record_number != null) {
        await releaseRecordNumber(client, "task", task.record_number);
      }
      await client.query("DELETE FROM tasks WHERE id = $1", [task.id]);

      await client.query(
        `
        UPDATE scheduled_tasks
        SET status = 'completed', completed_at = CURRENT_TIMESTAMP
        WHERE task_type = 'archive_cleanup'
          AND task_data->>'task_id' = $1
      `,
        [task.id.toString()]
      );

      console.log(`Successfully cleaned up task ${task.id}`);
    }

    // ---------- Placements ----------
    const archivedPlacementsResult = await client.query(
      `
      SELECT p.id, p.job_id, p.job_seeker_id, p.record_number
      FROM placements p
      WHERE p.status = 'Archived'
        AND p.archived_at IS NOT NULL
        AND p.archived_at <= CURRENT_TIMESTAMP - INTERVAL '7 days'
      `
    );

    const archivedPlacements = archivedPlacementsResult.rows;

    for (const placement of archivedPlacements) {
      console.log(`Cleaning up archived placement: ID ${placement.id}`);

      if (placement.record_number != null) {
        await releaseRecordNumber(client, "placement", placement.record_number);
      }

      await client.query(
        "DELETE FROM placement_notes WHERE placement_id = $1",
        [placement.id]
      );
      await client.query(
        "DELETE FROM placement_history WHERE placement_id = $1",
        [placement.id]
      );
      await client.query("DELETE FROM placements WHERE id = $1", [placement.id]);

      await client.query(
        `
        UPDATE scheduled_tasks
        SET status = 'completed', completed_at = CURRENT_TIMESTAMP
        WHERE task_type = 'archive_cleanup'
          AND task_data->>'placement_id' = $1
      `,
        [placement.id.toString()]
      );

      console.log(`Successfully cleaned up placement ${placement.id}`);
    }

    // ---------- Jobs ----------
    const archivedJobsResult = await client.query(
      `
      SELECT j.id, j.job_title, j.record_number
      FROM jobs j
      WHERE j.status = 'Archived'
        AND j.archived_at IS NOT NULL
        AND j.archived_at <= CURRENT_TIMESTAMP - INTERVAL '7 days'
      `
    );

    const archivedJobs = archivedJobsResult.rows;

    for (const job of archivedJobs) {
      console.log(`Cleaning up archived job: ${job.job_title || `ID ${job.id}`} (ID: ${job.id})`);

      await client.query(
        "DELETE FROM job_notes WHERE job_id = $1",
        [job.id]
      );
      await client.query(
        "DELETE FROM job_history WHERE job_id = $1",
        [job.id]
      );

      // Detach any appointments linked to this job before deleting the job
      await client.query(
        "UPDATE appointments SET job_id = NULL WHERE job_id = $1",
        [job.id]
      );

      if (job.record_number != null) {
        await releaseRecordNumber(client, "job", job.record_number);
      }
      await client.query("DELETE FROM jobs WHERE id = $1", [job.id]);

      await client.query(
        `
        UPDATE scheduled_tasks
        SET status = 'completed', completed_at = CURRENT_TIMESTAMP
        WHERE task_type = 'archive_cleanup'
          AND task_data->>'job_id' = $1
      `,
        [job.id.toString()]
      );

      console.log(`Successfully cleaned up job ${job.id}`);
    }

    await client.query("COMMIT");
    console.log(
      `Archive cleanup completed. Processed ${archivedOrgs.length} organizations, ${archivedHms.length} hiring managers, ${archivedJs.length} job seekers, ${archivedLeads.length} leads, ${archivedTasks.length} tasks, ${archivedPlacements.length} placements, ${archivedJobs.length} jobs.`
    );
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error running archive cleanup:", error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { runArchiveCleanup };
