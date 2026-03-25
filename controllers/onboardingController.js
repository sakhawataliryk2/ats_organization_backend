// controllers/onboardingController.js
const Onboarding = require("../models/onboarding");
const EmailTemplateModel = require("../models/emailTemplateModel");
const { sendMail } = require("../services/emailService");
const { renderTemplate, escapeHtml } = require("../utils/templateRenderer");
const Placement = require('../models/placement');
function esc(s = "") {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function normalizeEmails(input) {
  const arr = Array.isArray(input) ? input : [input];
  const flat = arr
    .filter(Boolean)
    .flatMap((x) => String(x).split(","))
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((addr) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr));
  return Array.from(new Set(flat));
}

class OnboardingController {
  constructor(pool) {
    this.pool = pool;
    this.onboardingModel = new Onboarding(pool);
    this.emailTemplateModel = new EmailTemplateModel(pool);
    this.placementModel = new Placement(pool);
  }

  async initTables() {
    return this.onboardingModel.initTables();
  }

  async buildEmail(type, vars, safeKeys = []) {
    const tpl = await this.emailTemplateModel.getTemplateByType(type);
    if (!tpl) return null;

    const subject = renderTemplate(tpl.subject, vars, safeKeys);
    let html = renderTemplate(tpl.body, vars, safeKeys);

    html = html.replace(/\r\n/g, "\n").replace(/\n/g, "<br/>");
    return { subject, html };
  }

  async getUserEmail(userId) {
    if (!userId) return null;
    const c = await this.pool.connect();
    try {
      const r = await c.query(`SELECT email FROM users WHERE id=$1 LIMIT 1`, [Number(userId)]);
      return r.rows[0]?.email || null;
    } finally {
      c.release();
    }
  }

  getPortalUrl() {
    return process.env.PORTAL_LOGIN_URL || `${process.env.FRONTEND_URL}/job-seeker-portal/login`;
  }

  getInternalRecipients = async ({ jobOwnerUserId, jobSeekerOwnerUserId }) => {
    const jobOwnerEmail = await this.getUserEmail(jobOwnerUserId);
    const jsOwnerEmail = await this.getUserEmail(jobSeekerOwnerUserId);

    return normalizeEmails([
      jobOwnerEmail,
      jsOwnerEmail,
    //  'sehrishsafder66@gmail.com',
      "onboarding@completestaffingsolutions.com",
    ]);
  };

  // -------------------------
  // 1) SEND (your existing one)
  // -------------------------
  send = async (req, res, next) => {
    try {
      const { job_seeker_id, job_id, packet_ids = [], document_ids = [] } = req.body;

      if (!job_seeker_id) return res.status(400).json({ success: false, message: "job_seeker_id is required" });
      if (!job_id) return res.status(400).json({ success: false, message: "job_id is required" });

      const senderUserId = req.user?.id || null;
      const senderName = req.user?.name || req.user?.full_name || req.user?.email || "System";

      // Load job
      let job;
      {
        const c = await this.pool.connect();
        try {
          const jr = await c.query(`SELECT id, job_title, created_by FROM jobs WHERE id=$1`, [Number(job_id)]);
          job = jr.rows[0];
        } finally {
          c.release();
        }
      }
      if (!job) return res.status(400).json({ success: false, message: "Invalid job_id" });
      const jobTitle = job.job_title || `Job #${job.id}`;
      const jobOwnerUserId = job.created_by || null;

      // Load job seeker
      let jobSeeker;
      {
        const c = await this.pool.connect();
        try {
          const js = await c.query(
            `SELECT id, email, first_name, last_name, created_by
             FROM job_seekers WHERE id=$1`,
            [Number(job_seeker_id)]
          );
          jobSeeker = js.rows[0];
        } finally {
          c.release();
        }
      }
      if (!jobSeeker?.email) return res.status(400).json({ success: false, message: "Job seeker email missing" });

      const jobSeekerName = `${jobSeeker.first_name || ""} ${jobSeeker.last_name || ""}`.trim();

      const templateDocIds = await this.onboardingModel.resolveTemplateDocIds({
        packet_ids: Array.isArray(packet_ids) ? packet_ids : [],
        document_ids: Array.isArray(document_ids) ? document_ids : [],
      });

      if (!templateDocIds.length) return res.status(400).json({ success: false, message: "No documents found in selection" });
      const alreadySentBefore = await this.onboardingModel.findAlreadySentActive(
        Number(job_seeker_id),
        templateDocIds
      );

      // If the document has already been sent, prevent sending it again
      if (Array.isArray(alreadySentBefore) && alreadySentBefore.length > 0) {
        return res.status(400).json({ success: false, message: "Document(s) already sent." });
      }

      // Treat this as first-time onboarding whenever there are no prior active sends
      const isFirstTime = !Array.isArray(alreadySentBefore) || alreadySentBefore.length === 0;

      let tempPassword = null;
      if (isFirstTime) {
        const portal = await this.onboardingModel.getOrCreatePortalAccount({
          job_seeker_id: Number(job_seeker_id),
          email: jobSeeker.email,
          created_by: senderUserId,
        });
        tempPassword = portal?.tempPassword || null;
      }

      // create send log
      const sendRow = await this.onboardingModel.createSend({
        job_seeker_id: Number(job_seeker_id),
        job_id: Number(job_id),
        recipient_email: jobSeeker.email,
        created_by: senderUserId,
        template_document_ids: templateDocIds,
      });

      const details = await this.onboardingModel.getSendDetails(sendRow.id);
      const docNames = (details?.items || []).map((x) => x.document_name);

      const noteText =
        `${jobSeekerName} has been sent Documents: ${docNames.join(", ")} for onboarding for Job ${jobTitle}.`;

      // notes
      await this.onboardingModel.insertJobSeekerNote({
        job_seeker_id: Number(job_seeker_id),
        text: noteText,
        created_by: senderUserId,
        action: "onboarding_sent",
        about_references: { job_id: Number(job_id), send_id: sendRow.id },
      });

      await this.onboardingModel.insertJobNote({
        job_id: Number(job_id),
        text: noteText,
        created_by: senderUserId,
        action: "onboarding_sent",
        about_references: { job_seeker_id: Number(job_seeker_id), send_id: sendRow.id },
      });

      // internal email
      const internalList = await this.getInternalRecipients({
        jobOwnerUserId,
        jobSeekerOwnerUserId: jobSeeker.created_by,
      });

      const docsList = `<ul>${docNames.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>`;

      const internalTpl =
        (await this.buildEmail(
          "ONBOARDING_INTERNAL_SENT",
          { jobSeekerName, sentBy: senderName, docsList, jobTitle, noteText },
          ["docsList"]
        )) || null;

      const internalHtml =
        internalTpl?.html ||
        `<div>
          <p>Hello</p>
          <p>${esc(noteText)}</p>
          <p>${docsList}</p>
          <p>Sent by <b>${esc(senderName)}</b></p>
        </div>`;

      await sendMail({
        to: internalList,
        subject: internalTpl?.subject || `Onboarding sent for ${jobSeekerName} – ${jobTitle}`,
        html: internalHtml,
      });

      // job seeker email
      const portalUrl = this.getPortalUrl();
      if (isFirstTime) {
        const email =
         (await this.buildEmail(
            "ONBOARDING_JOBSEEKER_FIRST_TIME",
            { jobSeekerName: jobSeekerName || "there", portalUrl, username: jobSeeker.email, tempPassword: tempPassword || "Use Forgot Password" },
            ["portalUrl"]
          )) || null;

        await sendMail({
          to: jobSeeker.email,
          subject: email?.subject || "Onboarding Documents - Portal Access",
          html:
            email?.html ||
            `<div>
              <p>Hello,</p>
              <p>You have onboarding documents that are awaiting your submission.</p>
              <p><b>Portal:</b> <a href="${esc(portalUrl)}">WEBSITE</a></p>
              <p><b>Username:</b> ${esc(jobSeeker.email)}</p>
              <p><b>Temporary Password:</b> ${esc(tempPassword || "")}</p>
            </div>`,
        });
      } else {
        const email =
          (await this.buildEmail(
            "ONBOARDING_JOBSEEKER_REPEAT",
            { jobSeekerName: jobSeekerName || "there", portalUrl },
            ["portalUrl"]
          )) || null;

        await sendMail({
          to: jobSeeker.email,
          subject: email?.subject || "Onboarding Documents Reminder",
          html:
            email?.html ||
            `<div>
              <p>Hello,</p>
              <p>You have onboarding documents that are awaiting your submission.</p>
              <p>Please login: <a href="${esc(portalUrl)}">WEBSITE</a></p>
            </div>`,
        });
      }

      return res.json({
        success: true,
        message: "Onboarding sent",
        send_id: sendRow.id,
        recipient: jobSeeker.email,
        first_time: isFirstTime,
        internal_recipients: internalList,
        items: (details?.items || []).map((i) => ({ id: i.id, document_name: i.document_name, status: i.status })),
      });
    } catch (err) {
      next(err);
    }
  };

  // -------------------------
  // 2) List docs for JobSeeker portal
  // -------------------------
 // GET /api/job-seeker-portal/documents/:id
getForJobSeeker = async (req, res, next) => {
  let client;
  try {
    const jobSeekerId = Number(req.params.id);
    if (!jobSeekerId) {
      return res.status(400).json({ success: false, message: "jobSeekerId is required in params" });
    }

    client = await this.pool.connect();

    // 1) fetch job seeker
    const jsRes = await client.query(
      `SELECT * FROM job_seekers WHERE id = $1`,
      [jobSeekerId]
    );
    const jobSeeker = jsRes.rows[0];
    if (!jobSeeker) {
      return res.status(404).json({ success: false, message: "Job seeker not found" });
    }

    // if custom_fields stored as JSON string sometimes:
    const customFields =
      typeof jobSeeker.custom_fields === "string"
        ? JSON.parse(jobSeeker.custom_fields || "{}")
        : (jobSeeker.custom_fields || {});

    // 2) list onboarding docs + mapped fields
    const items = await this.onboardingModel.listForJobSeeker(jobSeekerId);

    // 3) add current_value for each mapped field
    const hydrated = (items || []).map((doc) => ({
      ...doc,
      mapped_fields: (doc.mapped_fields || []).map((f) => ({
        ...f,
        current_value:
          jobSeeker[f.field_name] ??
          customFields[f.field_name] ??
          "",
      })),
    }));

    return res.json({ success: true, items: hydrated });
  } catch (err) {
    next(err);
  } finally {
    if (client) client.release();
  }
};
  // -------------------------
  // 3) JobSeeker SUBMIT document
  // status:
  // - if has_hold OR requires_admin_review => PENDING_ADMIN_REVIEW (admin reminder 3h)
  // - else => APPROVED (and completion email)
  // -------------------------
  submitOnboardingItem = async (req, res, next) => {
  try {
    const itemId = Number(req.params.itemId);
    const jobSeekerId = Number(req.body.job_seeker_id);

    if (!itemId || !jobSeekerId) {
      return res.status(400).json({
        success: false,
        message: "itemId + job_seeker_id required",
      });
    }

    const c = await this.pool.connect();
    let row;

    try {
      const r = await c.query(
        `
        SELECT
          oi.id AS item_id,
          oi.template_document_id,
          os.job_id,
          os.job_seeker_id,
          js.created_by AS jobseeker_owner_id,
          j.created_by AS job_owner_id,
          j.job_title,
          td.document_name
        FROM onboarding_send_items oi
        JOIN onboarding_sends os ON os.id = oi.onboarding_send_id
        JOIN template_documents td ON td.id = oi.template_document_id
        JOIN job_seekers js ON js.id = os.job_seeker_id
        JOIN jobs j ON j.id = os.job_id
        WHERE oi.id = $1 AND os.job_seeker_id = $2
        `,
        [itemId, jobSeekerId]
      );
      row = r.rows[0];
    } finally {
      c.release();
    }

    if (!row) {
      return res.status(404).json({
        success: false,
        message: "Item not found",
      });
    }

  // ✅ normalize submitted_fields (support both {name,value} and {field_name,value})
        const submittedFieldsRaw = Array.isArray(req.body.submitted_fields)
          ? req.body.submitted_fields
          : [];

        const submittedFields = submittedFieldsRaw
          .map((f) => ({
            field_name: f?.field_name || f?.name || "",
            value: f?.value ?? "",
          }))
          .filter((x) => x.field_name);

        if (!submittedFields.length) {
          return res.status(400).json({ success: false, message: "submitted_fields required" });
        }

        // ✅ SAVE submission in DB so admin-approve can fetch it later
    const c2 = await this.pool.connect();
      try {
        await c2.query(
          `
          INSERT INTO onboarding_item_submissions
            (onboarding_item_id, job_seeker_id, template_document_id, submitted_fields, created_at)
          VALUES
            ($1, $2, $3, $4::jsonb, NOW())
          `,
          [
            itemId,
            jobSeekerId,                 // ✅ NOT NULL column fix
            Number(row.template_document_id), // ✅ helpful for reporting
            JSON.stringify(submittedFields),
          ]
        );
      } finally {
        c2.release();
      } 
          
    await this.onboardingModel.applyDynamicFlowBack({
      job_seeker_id: jobSeekerId,
      template_document_id: row.template_document_id,
      submitted_fields: submittedFields,
    });

    const jobTitle = row.job_title || `Job #${row.job_id}`;

    // ✅ ALWAYS mark as SUBMITTED when jobseeker submits
    await this.onboardingModel.setItemStatus({
      item_id: itemId,
      status: "SUBMITTED",
      setCompletedAt: false,
      clearReminders: false,
    });

    // ✅ Proper note (NOT approved)
    await this.onboardingModel.insertJobSeekerNote({
      job_seeker_id: Number(row.job_seeker_id),
      text: `Document submitted: ${row.document_name} (Job: ${jobTitle}). Awaiting admin review.`,
      created_by: null,
      action: "onboarding_submitted",
      about_references: {
        job_id: row.job_id,
        onboarding_item_id: itemId,
      },
    });

    // Notify admin
    const internal = await this.getInternalRecipients({
      jobOwnerUserId: row.job_owner_id,
      jobSeekerOwnerUserId: row.jobseeker_owner_id,
    });

    await sendMail({
      to: internal,
      subject: `Review Required: ${row.document_name} (${jobTitle})`,
      html: `
        <div>
          <p>Document submitted and awaiting admin review:</p>
          <p><b>${row.document_name}</b></p>
          <p>Job: <b>${jobTitle}</b></p>
        </div>
      `,
    });

    return res.json({ success: true, status: "SUBMITTED" });

  } catch (err) {
    next(err);
  }
};

  // -------------------------
  // 4) Admin APPROVE item (after review/sign)
  // -------------------------
adminApproveItem = async (req, res, next) => {
  let client;
  try {
    const itemId = Number(req.params.itemId);
    const adminUserId = req.user?.id || null;

    if (!itemId) {
      return res.status(400).json({ success: false, message: "itemId required" });
    }

    client = await this.pool.connect();

    // ✅ 1) context + include template_document_id
    const ctxRes = await client.query(
      `
      SELECT
        oi.id AS item_id,
        oi.template_document_id,

        os.job_id,
        os.job_seeker_id,

        js.created_by AS jobseeker_owner_id,
        j.created_by AS job_owner_id,

        j.job_title,
        td.document_name
      FROM onboarding_send_items oi
      JOIN onboarding_sends os ON os.id = oi.onboarding_send_id
      JOIN template_documents td ON td.id = oi.template_document_id
      JOIN job_seekers js ON js.id = os.job_seeker_id
      JOIN jobs j ON j.id = os.job_id
      WHERE oi.id = $1
      `,
      [itemId]
    );

    const row = ctxRes.rows[0];
    if (!row) return res.status(404).json({ success: false, message: "Item not found" });

    // ✅ 2) pull latest submission from DB (NOT from req.body)
    const subRes = await client.query(
      `
      SELECT s.submitted_fields
      FROM onboarding_item_submissions s
      WHERE s.onboarding_item_id = $1
      ORDER BY s.created_at DESC
      LIMIT 1
      `,
      [itemId]
    );

    let submittedFields = subRes.rows?.[0]?.submitted_fields ?? [];

    if (typeof submittedFields === "string") {
      try { submittedFields = JSON.parse(submittedFields || "[]"); } catch { submittedFields = []; }
    }

    if (!Array.isArray(submittedFields) || !submittedFields.length) {
      return res.status(400).json({
        success: false,
        message: "No submitted_fields found for this item. Jobseeker must submit first.",
      });
    }

    // ✅ normalize shape { name, value } OR { field_name, value }
    submittedFields = submittedFields
      .map((f) => ({
        field_name: f?.field_name || f?.name || "",
        value: f?.value ?? "",
      }))
      .filter((x) => x.field_name);

    // ✅ 3) Apply dynamic flow-back (FIX jobSeekerId bug)
    await this.onboardingModel.applyDynamicFlowBack({
      job_seeker_id: Number(row.job_seeker_id),
      template_document_id: Number(row.template_document_id),
      submitted_fields: submittedFields,
    });

    // ✅ 4) set status APPROVED + completed_at
    await this.onboardingModel.setItemStatus({
      item_id: itemId,
      status: "APPROVED",
      completed_by: adminUserId,
      setCompletedAt: true,
      clearReminders: true,
    });

    // ✅ 5) notes
    const portalUrl = this.getPortalUrl();
    const jobTitle = row.job_title || `Job #${row.job_id}`;

    await this.onboardingModel.insertJobSeekerNote({
      job_seeker_id: Number(row.job_seeker_id),
      text: `Admin approved document: ${row.document_name} (Job: ${jobTitle}).`,
      created_by: adminUserId,
      action: "onboarding_admin_approved",
      about_references: { job_id: row.job_id, onboarding_item_id: itemId },
    });

    // ✅ 6) emails internal
    const internal = await this.getInternalRecipients({
      jobOwnerUserId: row.job_owner_id,
      jobSeekerOwnerUserId: row.jobseeker_owner_id,
    });

    const tpl =
      (await this.buildEmail(
        "ONBOARDING_DOCUMENT_COMPLETED",
        { jobTitle, portalUrl, documentName: row.document_name },
        ["portalUrl"]
      )) || null;

    await sendMail({
      to: internal,
      subject: tpl?.subject || `Document Completed: ${row.document_name} (${jobTitle})`,
      html:
        tpl?.html ||
        `<div>
          <p>Document completed: <b>${esc(row.document_name)}</b></p>
          <p>Job: <b>${esc(jobTitle)}</b></p>
        </div>`,
    });
    await this.placementModel.create({
      job_seeker_id: row.job_seeker_id, 
      job_id: row.job_id,  
      start_date: new Date(),  
      custom_fields: row.custom_fields || {},
    });


    return res.json({ success: true, status: "APPROVED" });
  } catch (err) {
    next(err);
  } finally {
    if (client) client.release();
  }
};

  // -------------------------
  // 5) Admin REJECT item (reason required)
  // - status -> REJECTED
  // - reset flowback fields
  // - email JobSeeker + internal
  // - reschedule jobseeker reminder 6h
  // -------------------------
  rejectItem = async (req, res, next) => {
    try {
      const itemId = Number(req.params.itemId);
      const reason = String(req.body.reason || "").trim();
      const adminUserId = req.user?.id || null;

      if (!itemId) return res.status(400).json({ success: false, message: "itemId required" });
      if (!reason) return res.status(400).json({ success: false, message: "reason required" });

      const ctx = await this.onboardingModel.rejectItem({
        item_id: itemId,
        rejected_by: adminUserId,
        reason,
      });

      if (!ctx) return res.status(404).json({ success: false, message: "Item not found" });

      // Pull jobseeker email + owners for sending
      const c = await this.pool.connect();
      let row;
      try {
        const r = await c.query(
          `
          SELECT
            js.email AS jobseeker_email,
            js.created_by AS jobseeker_owner_id,
            j.created_by AS job_owner_id,
            j.job_title,
            td.document_name
          FROM onboarding_send_items oi
          JOIN onboarding_sends os ON os.id = oi.onboarding_send_id
          JOIN template_documents td ON td.id = oi.template_document_id
          JOIN job_seekers js ON js.id = os.job_seeker_id
          JOIN jobs j ON j.id = os.job_id
          WHERE oi.id = $1
          `,
          [itemId]
        );
        row = r.rows[0];
      } finally {
        c.release();
      }

      const portalUrl = this.getPortalUrl();
      const jobTitle = row?.job_title || `Job #${ctx.job_id}`;

      // notes
      await this.onboardingModel.insertJobSeekerNote({
        job_seeker_id: Number(ctx.job_seeker_id),
        text: `Document rejected: ${row?.document_name}. Reason: ${reason}`,
        created_by: adminUserId,
        action: "onboarding_rejected",
        about_references: { job_id: ctx.job_id, onboarding_item_id: itemId },
      });

      // emails
      const internal = await this.getInternalRecipients({
        jobOwnerUserId: row?.job_owner_id,
        jobSeekerOwnerUserId: row?.jobseeker_owner_id,
      });

      const toJobSeeker = normalizeEmails(row?.jobseeker_email);

      const tpl =
        (await this.buildEmail(
          "ONBOARDING_DOCUMENT_REJECTED",
          { jobTitle, portalUrl, documentName: row?.document_name, reason },
          ["portalUrl"]
        )) || null;

      const subject = tpl?.subject || `Action Required: Document Rejected (${jobTitle})`;
      const html =
        tpl?.html ||
        `<div>
          <p>Your document was rejected: <b>${esc(row?.document_name || "")}</b></p>
          <p><b>Reason:</b> ${esc(reason)}</p>
          <p>Please login and re-submit: <a href="${esc(portalUrl)}">Portal</a></p>
        </div>`;

      // send to jobseeker + internal
      if (toJobSeeker.length) {
        await sendMail({ to: toJobSeeker, subject, html });
      }
      if (internal.length) {
        await sendMail({ to: internal, subject: `[Internal] ${subject}`, html });
      }

      return res.json({ success: true, status: "REJECTED" });
    } catch (err) {
      next(err);
    }
  };

  // -------------------------
  // 6) CRON RUNNER: reminders
  // JobSeeker every 6h until approved/completed
  // Admin every 3h while PENDING_ADMIN_REVIEW
  // Also creates jobseeker note automatically
  // -------------------------
  runReminders = async (req, res, next) => {
    try {
      const portalUrl = this.getPortalUrl();

      const jsItems = await this.onboardingModel.listDueJobSeekerReminders(100);
      const adminItems = await this.onboardingModel.listDueAdminReminders(100);

      let jsSent = 0;
      let adminSent = 0;
      const errors = [];

      // JobSeeker reminders (6 hours)
      for (const row of jsItems) {
        try {
          const to = normalizeEmails(row.jobseeker_email);
          if (!to.length) continue;

          const jobTitle = row.job_title || `Job #${row.job_id}`;
          const jobSeekerName = `${row.first_name || ""} ${row.last_name || ""}`.trim() || "Job Seeker";

          const tpl =
            (await this.buildEmail(
              "ONBOARDING_JOBSEEKER_REMINDER",
              { jobTitle, portalUrl, jobSeekerName, documentName: row.document_name },
              ["portalUrl"]
            )) || null;

          await sendMail({
            to,
            subject: tpl?.subject || `Reminder: Onboarding pending (${jobTitle})`,
            html:
              tpl?.html ||
              `<div>
                <p>Hello ${esc(jobSeekerName)},</p>
                <p>Reminder: you still have onboarding documents pending for <b>${esc(jobTitle)}</b>.</p>
                <p>Pending: <b>${esc(row.document_name)}</b></p>
                <p><a href="${esc(portalUrl)}">Open portal</a></p>
              </div>`,
          });

          await this.onboardingModel.insertJobSeekerNote({
            job_seeker_id: Number(row.job_seeker_id),
            text: `Reminder email sent to Job Seeker for pending onboarding document: ${row.document_name} (Job: ${jobTitle}).`,
            created_by: null,
            action: "onboarding_reminder_sent",
            about_references: { job_id: row.job_id, onboarding_item_id: row.item_id },
          });

          await this.onboardingModel.markReminderSentAndReschedule({ item_id: row.item_id, hours: 6 });
          jsSent++;
        } catch (e) {
          errors.push({ item_id: row.item_id, error: e.message });
        }
      }

      // Admin reminders (3 hours)
      for (const row of adminItems) {
        try {
          const internal = await this.getInternalRecipients({
            jobOwnerUserId: row.job_owner_id,
            jobSeekerOwnerUserId: row.jobseeker_owner_id,
          });

          if (!internal.length) continue;

          const jobTitle = row.job_title || `Job #${row.job_id}`;

          const tpl =
            (await this.buildEmail(
              "ONBOARDING_ADMIN_REVIEW_REMINDER",
              { jobTitle, portalUrl, documentName: row.document_name },
              ["portalUrl"]
            )) || null;

          await sendMail({
            to: internal,
            subject: tpl?.subject || `Admin Review Reminder: ${row.document_name} (${jobTitle})`,
            html:
              tpl?.html ||
              `<div>
                <p>Hello,</p>
                <p>Reminder: document pending admin review:</p>
                <p><b>${esc(row.document_name)}</b> (Job: <b>${esc(jobTitle)}</b>)</p>
                <p><a href="${esc(portalUrl)}">Open portal</a></p>
              </div>`,
          });

          await this.onboardingModel.insertJobSeekerNote({
            job_seeker_id: Number(row.job_seeker_id),
            text: `Admin review reminder sent for document: ${row.document_name} (Job: ${jobTitle}).`,
            created_by: null,
            action: "onboarding_admin_review_reminder_sent",
            about_references: { job_id: row.job_id, onboarding_item_id: row.item_id },
          });

          await this.onboardingModel.markReminderSentAndReschedule({ item_id: row.item_id, hours: 3 });
          adminSent++;
        } catch (e) {
          errors.push({ item_id: row.item_id, error: e.message });
        }
      }

      return res.json({
        success: true,
        message: `Reminders processed. JobSeeker sent: ${jsSent}, Admin sent: ${adminSent}`,
        jsSent,
        adminSent,
        errors,
      });
    } catch (err) {
      next(err);
    }
  };

  // -------------------------
  // 7) Timecard access check (backend)
  // -------------------------
  timecardAccess = async (req, res, next) => {
    try {
      const jobSeekerId = Number(req.params.id);
      const ok = await this.onboardingModel.canAccessTimecard(jobSeekerId);
      return res.json({ success: true, timecard_enabled: !!ok });
    } catch (err) {
      next(err);
    }
  };
getOnboardingItem = async (req, res, next) => {
  let client;
  try {
    const itemId = Number(req.params.itemId);
    if (!itemId) return res.status(400).json({ success: false, message: "itemId required" });

    client = await this.pool.connect();

    const r = await client.query(
      `
      SELECT
        osi.id,
        osi.status,
        osi.sent_at,
        osi.completed_at,

        osi.template_document_id,

        td.document_name,
        td.file_url,
        td.file_name,
        td.mime_type,

        os.job_seeker_id,
        js.custom_fields AS jobseeker_custom_fields,

        -- latest submission (if exists)
        sub.submitted_fields AS submitted_fields,

        COALESCE(
          json_agg(
            DISTINCT jsonb_build_object(
              'field_name', f.field_name,
              'field_label', f.field_label,
              'field_type', f.field_type,
              'x', f.x, 'y', f.y, 'w', f.w, 'h', f.h
            )
          ) FILTER (WHERE f.id IS NOT NULL),
          '[]'::json
        ) AS mapped_fields

      FROM onboarding_sends os
      JOIN onboarding_send_items osi ON osi.onboarding_send_id = os.id
      JOIN template_documents td ON td.id = osi.template_document_id
      JOIN job_seekers js ON js.id = os.job_seeker_id
      LEFT JOIN template_document_mappings f ON f.template_document_id = td.id

      LEFT JOIN LATERAL (
        SELECT s.submitted_fields
        FROM onboarding_item_submissions s
        WHERE s.onboarding_item_id = osi.id
        ORDER BY s.created_at DESC
        LIMIT 1
      ) sub ON true

      WHERE osi.id = $1
      GROUP BY osi.id, td.id, os.id, js.id, sub.submitted_fields
      `,
      [itemId]
    );

    const row = r.rows[0];
    if (!row) return res.status(404).json({ success: false, message: "Item not found" });

    // parse custom_fields
    const customFields =
      typeof row.jobseeker_custom_fields === "string"
        ? JSON.parse(row.jobseeker_custom_fields || "{}")
        : (row.jobseeker_custom_fields || {});

    // parse submitted_fields
    let submitted = row.submitted_fields;
    if (typeof submitted === "string") {
      try { submitted = JSON.parse(submitted || "[]"); } catch { submitted = []; }
    }
    if (!Array.isArray(submitted)) submitted = [];

    // normalize submitted -> { field_name, value }
    const normalizedSubmitted = submitted
      .map((f) => ({
        field_name: f?.field_name || f?.name || "",
        value: f?.value ?? "",
      }))
      .filter((x) => x.field_name);

    // build jobseekerData
    const jobseekerData = {};

    if (normalizedSubmitted.length) {
      for (const f of normalizedSubmitted) {
        jobseekerData[f.field_name] = String(f.value ?? "");
      }
    } else {
      // fallback: fill from customFields using label
      const mapped = Array.isArray(row.mapped_fields) ? row.mapped_fields : [];
      for (const mf of mapped) {
        const key = mf?.field_name;
        if (!key) continue;

        const label = mf?.field_label;
        jobseekerData[key] = String(
          (label && customFields?.[label] !== undefined ? customFields[label] : customFields?.[key]) ?? ""
        );
      }
    }

    const doc = {
      id: row.id,
      template_document_id: row.template_document_id,
      document_name: row.document_name,
      status: row.status,
      sent_at: row.sent_at,
      completed_at: row.completed_at,

      file_url: row.file_url,
      file_name: row.file_name,
      mime_type: row.mime_type,

      mapped_fields: row.mapped_fields || [],
      submitted_fields: normalizedSubmitted, // optional
      jobseekerData,
    };

    // ✅ EXACT SHAPE YOU WANT
    return res.json({
      success: true,
      documents: [doc],
    });
  } catch (err) {
    next(err);
  } finally {
    if (client) client.release();
  }
};

  
}




module.exports = OnboardingController;