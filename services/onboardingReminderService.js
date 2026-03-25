// services/onboardingReminderService.js
const EmailTemplateModel = require("../models/emailTemplateModel");
const { sendMail } = require("./emailService");
const { renderTemplate } = require("../utils/templateRenderer");

function esc(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function safeEmailList(input) {
  const arr = Array.isArray(input) ? input : [input];
  const flat = arr
    .filter(Boolean)
    .flatMap((x) => String(x).split(","))
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((addr) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr));
  return Array.from(new Set(flat));
}

async function getUserEmail(pool, userId) {
  if (!userId) return null;
  const c = await pool.connect();
  try {
    const r = await c.query(`SELECT email FROM users WHERE id=$1 LIMIT 1`, [
      Number(userId),
    ]);
    return r.rows[0]?.email || null;
  } finally {
    c.release();
  }
}

function buildPortalUrl() {
  return (
    process.env.PORTAL_LOGIN_URL ||
    `${process.env.APP_PUBLIC_URL}/job-seeker-portal/login`
  );
}

function makeInternalRecipients({ jobOwnerEmail, jobSeekerOwnerEmail }) {
  return safeEmailList([
    jobOwnerEmail,
    jobSeekerOwnerEmail,
    "onboarding@completestaffingsolutions.com",
  ]);
}

/**
 * Onboarding reminder runner (JobSeeker every 6 hrs until all completed)
 * Admin review reminder (every 3 hrs until admin completes)
 *
 * Required columns on onboarding_send_items:
 * - status
 * - next_reminder_at
 * - last_reminded_at
 * - reminder_role (optional)
 * - requires_admin_review (optional boolean)
 *
 * Status suggestions:
 * - JobSeeker pending: 'SENT', 'REJECTED', 'PENDING_JOBSEEKER'
 * - Admin pending: 'PENDING_ADMIN_REVIEW'
 */
async function runOnboardingReminders(pool, onboardingModel) {
  const emailTemplateModel = new EmailTemplateModel(pool);

  console.log(
    `[onboardingReminders] Starting reminder check at ${new Date().toISOString()}`
  );

  const results = { jobseeker_sent: 0, admin_sent: 0, errors: [] };

  const jobSeekerTpl = await emailTemplateModel.getTemplateByType(
    "ONBOARDING_JOBSEEKER_REMINDER"
  );
  console.log(
    `[onboardingReminders] JobSeeker template ${
      jobSeekerTpl ? "found" : "not found, using default"
    }`
  );

  const adminTpl = await emailTemplateModel.getTemplateByType(
    "ONBOARDING_ADMIN_REVIEW_REMINDER"
  );
  console.log(
    `[onboardingReminders] Admin template ${
      adminTpl ? "found" : "not found, using default"
    }`
  );

  const portalUrl = buildPortalUrl();

  // 1) JobSeeker reminders (every 6 hours)
  // NOTE: LIMIT 100 to avoid huge bursts
  const client = await pool.connect();
  let jsRows = [];
  let adminRows = [];

  try {
    const jsRes = await client.query(
      `
      SELECT
        oi.id AS item_id,
        oi.job_seeker_id,
        oi.job_id,
        oi.status,
        oi.next_reminder_at,
        td.document_name,
        js.email AS jobseeker_email,
        js.first_name,
        js.last_name,
        js.created_by AS jobseeker_owner_id,
        j.created_by AS job_owner_id,
        j.job_title
      FROM onboarding_send_items oi
      JOIN template_documents td ON td.id = oi.template_document_id
      JOIN job_seekers js ON js.id = oi.job_seeker_id
      JOIN jobs j ON j.id = oi.job_id
      WHERE oi.next_reminder_at IS NOT NULL
        AND oi.next_reminder_at <= NOW()
        AND oi.status IN ('SENT','REJECTED','PENDING_JOBSEEKER')
      ORDER BY oi.next_reminder_at ASC
      LIMIT 100
    `
    );

    jsRows = jsRes.rows || [];

    const adminRes = await client.query(
      `
      SELECT
        oi.id AS item_id,
        oi.job_seeker_id,
        oi.job_id,
        oi.status,
        oi.next_reminder_at,
        td.document_name,
        js.created_by AS jobseeker_owner_id,
        j.created_by AS job_owner_id,
        j.job_title
      FROM onboarding_send_items oi
      JOIN template_documents td ON td.id = oi.template_document_id
      JOIN job_seekers js ON js.id = oi.job_seeker_id
      JOIN jobs j ON j.id = oi.job_id
      WHERE oi.next_reminder_at IS NOT NULL
        AND oi.next_reminder_at <= NOW()
        AND oi.status IN ('PENDING_ADMIN_REVIEW')
      ORDER BY oi.next_reminder_at ASC
      LIMIT 100
    `
    );

    adminRows = adminRes.rows || [];
  } finally {
    client.release();
  }

  console.log(
    `[onboardingReminders] Found ${jsRows.length} jobseeker reminder item(s), ${adminRows.length} admin reminder item(s)`
  );

  if (jsRows.length > 0) {
    console.log(
      `[onboardingReminders] JobSeeker reminder items:`,
      jsRows.map((r) => ({
        item_id: r.item_id,
        job_seeker_id: r.job_seeker_id,
        job_id: r.job_id,
        status: r.status,
        next_reminder_at: r.next_reminder_at,
        document_name: r.document_name,
        jobseeker_email: r.jobseeker_email,
      }))
    );
  }

  if (adminRows.length > 0) {
    console.log(
      `[onboardingReminders] Admin reminder items:`,
      adminRows.map((r) => ({
        item_id: r.item_id,
        job_seeker_id: r.job_seeker_id,
        job_id: r.job_id,
        status: r.status,
        next_reminder_at: r.next_reminder_at,
        document_name: r.document_name,
      }))
    );
  }

  // Process JobSeeker reminders
  for (const row of jsRows) {
    try {
      const jobSeekerName = `${row.first_name || ""} ${
        row.last_name || ""
      }`.trim();

      const to = safeEmailList(row.jobseeker_email);
      if (!to.length) {
        results.errors.push({
          item_id: row.item_id,
          error: "Missing/invalid jobseeker email",
        });
        continue;
      }

      const vars = {
        jobSeekerName: jobSeekerName || "Job Seeker",
        jobTitle: row.job_title || `Job #${row.job_id}`,
        portalUrl,
        documentName: row.document_name || "Onboarding Document",
      };

      let subject, html, text;

      if (jobSeekerTpl) {
        subject = renderTemplate(jobSeekerTpl.subject, vars, ["portalUrl"]);
        html = renderTemplate(jobSeekerTpl.body, vars, ["portalUrl"]);
        html = html.replace(/\r\n/g, "\n").replace(/\n/g, "<br/>");
        text = renderTemplate(jobSeekerTpl.body, vars, ["portalUrl"]);
      } else {
        subject = `Reminder: Onboarding documents pending for ${vars.jobTitle}`;
        html = `
          <div>
            <p>Hello ${esc(vars.jobSeekerName)},</p>
            <p>This is a reminder that you still have onboarding documents pending for <b>${esc(
              vars.jobTitle
            )}</b>.</p>
            <p><b>Pending document:</b> ${esc(vars.documentName)}</p>
            <p>Please login: <a href="${esc(portalUrl)}">Portal</a></p>
            <p>Thank you</p>
          </div>
        `;
        text = `Reminder: onboarding documents pending for ${vars.jobTitle}. Pending: ${vars.documentName}. Portal: ${portalUrl}`;
      }

      console.log(
        `[onboardingReminders] Sending JobSeeker reminder to: ${to.join(
          ", "
        )} (item ${row.item_id})`
      );

      await sendMail({ to, subject, html, text });

      // Note under JobSeeker record
      await onboardingModel.insertJobSeekerNote({
        job_seeker_id: Number(row.job_seeker_id),
        text: `Reminder sent to Job Seeker for pending onboarding document: ${row.document_name} (Job: ${row.job_title}).`,
        created_by: null,
        action: "onboarding_reminder_sent",
        about_references: {
          job_id: Number(row.job_id),
          onboarding_item_id: Number(row.item_id),
        },
      });

      // Schedule next reminder after 6 hours
      const c = await pool.connect();
      try {
        await c.query(
          `
          UPDATE onboarding_send_items
          SET last_reminded_at = NOW(),
              next_reminder_at = NOW() + interval '6 hours'
          WHERE id = $1
        `,
          [Number(row.item_id)]
        );
      } finally {
        c.release();
      }

      results.jobseeker_sent++;
    } catch (err) {
      console.error(
        `[onboardingReminders] Error sending JobSeeker reminder (item ${row.item_id}):`,
        err
      );
      results.errors.push({
        item_id: row.item_id,
        error: err.message,
      });
    }
  }

  // Process Admin reminders
  for (const row of adminRows) {
    try {
      const jobOwnerEmail = await getUserEmail(pool, row.job_owner_id);
      const jobSeekerOwnerEmail = await getUserEmail(
        pool,
        row.jobseeker_owner_id
      );

      const internal = makeInternalRecipients({ jobOwnerEmail, jobSeekerOwnerEmail });

      if (!internal.length) {
        results.errors.push({
          item_id: row.item_id,
          error: "No internal recipients resolved",
        });
        continue;
      }

      const vars = {
        jobTitle: row.job_title || `Job #${row.job_id}`,
        documentName: row.document_name || "Onboarding Document",
        portalUrl,
      };

      let subject, html, text;

      if (adminTpl) {
        subject = renderTemplate(adminTpl.subject, vars, ["portalUrl"]);
        html = renderTemplate(adminTpl.body, vars, ["portalUrl"]);
        html = html.replace(/\r\n/g, "\n").replace(/\n/g, "<br/>");
        text = renderTemplate(adminTpl.body, vars, ["portalUrl"]);
      } else {
        subject = `Admin Review Reminder: ${vars.documentName} (Job: ${vars.jobTitle})`;
        html = `
          <div>
            <p>Hello,</p>
            <p>This is a reminder that an onboarding document is pending admin review:</p>
            <p><b>${esc(vars.documentName)}</b> (Job: <b>${esc(
          vars.jobTitle
        )}</b>)</p>
            <p>Please login to review: <a href="${esc(portalUrl)}">Portal</a></p>
          </div>
        `;
        text = `Admin review reminder. Document: ${vars.documentName}. Job: ${vars.jobTitle}. Portal: ${portalUrl}`;
      }

      console.log(
        `[onboardingReminders] Sending Admin reminder to: ${internal.join(
          ", "
        )} (item ${row.item_id})`
      );

      await sendMail({
        to: internal,
        subject,
        html,
        text,
      });

      // Note under JobSeeker record
      await onboardingModel.insertJobSeekerNote({
        job_seeker_id: Number(row.job_seeker_id),
        text: `Admin review reminder sent for pending onboarding document: ${row.document_name} (Job: ${row.job_title}).`,
        created_by: null,
        action: "onboarding_admin_review_reminder_sent",
        about_references: {
          job_id: Number(row.job_id),
          onboarding_item_id: Number(row.item_id),
        },
      });

      // Schedule next reminder after 3 hours
      const c = await pool.connect();
      try {
        await c.query(
          `
          UPDATE onboarding_send_items
          SET last_reminded_at = NOW(),
              next_reminder_at = NOW() + interval '3 hours'
          WHERE id = $1
        `,
          [Number(row.item_id)]
        );
      } finally {
        c.release();
      }

      results.admin_sent++;
    } catch (err) {
      console.error(
        `[onboardingReminders] Error sending Admin reminder (item ${row.item_id}):`,
        err
      );
      results.errors.push({
        item_id: row.item_id,
        error: err.message,
      });
    }
  }

  const response = {
    success: true,
    message: `Processed reminders: jobseeker sent ${results.jobseeker_sent}, admin sent ${results.admin_sent}`,
    ...results,
  };

  console.log(`[onboardingReminders] Completed: ${response.message}`);
  if (results.errors.length > 0) {
    console.log(`[onboardingReminders] Errors:`, results.errors);
  }

  return response;
}

module.exports = { runOnboardingReminders };