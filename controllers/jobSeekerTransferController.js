// controllers/jobSeekerTransferController.js
const JobSeekerTransfer = require("../models/jobSeekerTransfer");
const JobSeeker = require("../models/jobseeker");
const EmailTemplateModel = require("../models/emailTemplateModel");
const { renderTemplate } = require("../utils/templateRenderer");
const { sendMail } = require("../services/emailService");

const PAYROLL_EMAIL = "onboarding@completestaffingsolutions.com";
// const PAYROLL_EMAIL = "yasirrehman274@gmail.com";

class JobSeekerTransferController {
  constructor(pool) {
    this.pool = pool;
    this.transferModel = new JobSeekerTransfer(pool);
    this.jobSeekerModel = new JobSeeker(pool);
    this.emailTemplateModel = new EmailTemplateModel(pool);
    this.create = this.create.bind(this);
    this.getById = this.getById.bind(this);
    this.approve = this.approve.bind(this);
    this.deny = this.deny.bind(this);
  }

  async create(req, res) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      const {
        source_job_seeker_id,
        target_job_seeker_id,
        requested_by,
        requested_by_email,
        source_record_number,
        target_record_number,
      } = req.body;

      if (!source_job_seeker_id || !target_job_seeker_id) {
        return res.status(400).json({
          success: false,
          message: "Source and target job seeker IDs are required",
        });
      }

      if (Number(source_job_seeker_id) === Number(target_job_seeker_id)) {
        return res.status(400).json({
          success: false,
          message: "Cannot transfer to the same job seeker",
        });
      }

      const client = await this.pool.connect();
      let user = {};
      try {
        const userQuery = await client.query(
          "SELECT name, email FROM users WHERE id = $1",
          [userId]
        );
        user = userQuery.rows[0] || {};
      } finally {
        client.release();
      }

      const requester = {
        name: requested_by || user.name || "Unknown",
        email: requested_by_email || user.email || "",
      };

      const transfer = await this.transferModel.create({
        source_job_seeker_id: Number(source_job_seeker_id),
        target_job_seeker_id: Number(target_job_seeker_id),
        requested_by: userId,
        requested_by_name: requester.name,
        requested_by_email: requester.email,
        source_record_number: source_record_number || null,
        target_record_number: target_record_number || null,
      });

      try {
        await this.sendTransferRequestEmail(transfer, requester);
      } catch (emailError) {
        console.error("Error sending job seeker transfer request email:", emailError);
      }

      return res.status(201).json({
        success: true,
        message: "Job seeker transfer request created successfully",
        transfer,
      });
    } catch (error) {
      console.error("Error creating job seeker transfer:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to create transfer request",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async sendTransferRequestEmail(transfer, requester) {
    const baseUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const approvalUrl = `${baseUrl}/dashboard/job-seekers/transfer/${transfer.id}/approve`;
    const denyUrl = `${baseUrl}/dashboard/job-seekers/transfer/${transfer.id}/deny`;

    const templateType = "JOB_SEEKER_TRANSFER_REQUEST";
    const tpl = await this.emailTemplateModel.getTemplateByType(templateType);

    const requestDate = new Date(transfer.created_at).toLocaleString();
    const approvalButtonHtml =
      `<a href="${approvalUrl}" style="display:inline-block;background-color:#4CAF50;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;margin-right:10px;">Approve Transfer</a>`;
    const denyButtonHtml =
      `<a href="${denyUrl}" style="display:inline-block;background-color:#f44336;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">Deny Transfer</a>`;

    const fullTransfer = await this.transferModel.getById(transfer.id);
    const sourceName = fullTransfer?.source_js_name || transfer.source_record_number || "";
    const targetName = fullTransfer?.target_js_name || transfer.target_record_number || "";

    const vars = {
      requestedBy: requester.name || "Unknown",
      requestedByEmail: requester.email || "",
      sourceRecordNumber: transfer.source_record_number || "",
      targetRecordNumber: transfer.target_record_number || "",
      requestDate,
      approvalUrl,
      denyUrl,
    };
    const bodyVars = {
      ...vars,
      approvalUrl: approvalButtonHtml,
      denyUrl: denyButtonHtml,
    };
    const safeKeys = ["approvalUrl", "denyUrl"];

    if (tpl) {
      const subject = renderTemplate(tpl.subject, vars, safeKeys);
      let html = renderTemplate(tpl.body, bodyVars, safeKeys);
      html = html.replace(/\r\n/g, "\n").replace(/\n/g, "<br/>");
      await sendMail({
        to: PAYROLL_EMAIL,
        subject,
        html,
      });
    } else {
      await sendMail({
        to: PAYROLL_EMAIL,
        subject: `Job Seeker Transfer Request: ${vars.sourceRecordNumber} → ${vars.targetRecordNumber}`,
        html: `
          <h2>Job Seeker Transfer Request</h2>
          <p>A transfer request has been submitted (job seeker to job seeker):</p>
          <ul>
            <li><strong>Requested By:</strong> ${vars.requestedBy} (${vars.requestedByEmail})</li>
            <li><strong>Source Job Seeker:</strong> ${sourceName} (${vars.sourceRecordNumber})</li>
            <li><strong>Target Job Seeker:</strong> ${targetName} (${vars.targetRecordNumber})</li>
            <li><strong>Request Date:</strong> ${requestDate}</li>
          </ul>
          <p>If approved, notes, documents, tasks, placements, and applications linked to the source job seeker will be moved to the target. The source job seeker will be archived.</p>
          <p>Please review and approve or deny:</p>
          <p>${approvalButtonHtml} ${denyButtonHtml}</p>
        `,
      });
    }
  }

  async getById(req, res) {
    try {
      const { id } = req.params;
      const transfer = await this.transferModel.getById(id);
      if (!transfer) {
        return res.status(404).json({
          success: false,
          message: "Transfer request not found",
        });
      }
      return res.json({
        success: true,
        transfer,
      });
    } catch (error) {
      console.error("Error fetching job seeker transfer:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch transfer request",
      });
    }
  }

  async approve(req, res) {
    try {
      const userId = req.user?.id;
      const { id } = req.params;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      const transfer = await this.transferModel.getById(id);
      if (!transfer) {
        return res.status(404).json({
          success: false,
          message: "Transfer request not found",
        });
      }

      if (transfer.status !== "pending") {
        return res.status(400).json({
          success: false,
          message: `Transfer request is already ${transfer.status}`,
        });
      }

      const approvedTransfer = await this.transferModel.approve(id, userId);
      await this.executeJobSeekerTransfer(approvedTransfer);

      try {
        await this.sendApprovalEmail(approvedTransfer);
      } catch (emailError) {
        console.error("Error sending approval email:", emailError);
      }

      return res.json({
        success: true,
        message: "Job seeker transfer approved and executed successfully",
        transfer: approvedTransfer,
      });
    } catch (error) {
      console.error("Error approving job seeker transfer:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to approve transfer",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async deny(req, res) {
    try {
      const userId = req.user?.id;
      const { id } = req.params;
      const { denial_reason } = req.body;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      if (!denial_reason || !denial_reason.trim()) {
        return res.status(400).json({
          success: false,
          message: "Denial reason is required",
        });
      }

      const transfer = await this.transferModel.getById(id);
      if (!transfer) {
        return res.status(404).json({
          success: false,
          message: "Transfer request not found",
        });
      }

      if (transfer.status !== "pending") {
        return res.status(400).json({
          success: false,
          message: `Transfer request is already ${transfer.status}`,
        });
      }

      const deniedTransfer = await this.transferModel.deny(
        id,
        denial_reason.trim(),
        userId
      );

      try {
        await this.jobSeekerModel.addNote(
          transfer.source_job_seeker_id,
          `Transfer denied: ${denial_reason.trim()}`,
          userId
        );
        await this.jobSeekerModel.addNote(
          transfer.target_job_seeker_id,
          `Transfer denied: ${denial_reason.trim()}`,
          userId
        );
      } catch (noteError) {
        console.error("Error adding denial notes:", noteError);
      }

      try {
        await this.sendDenialEmail(deniedTransfer, denial_reason.trim());
      } catch (emailError) {
        console.error("Error sending denial email:", emailError);
      }

      return res.json({
        success: true,
        message: "Transfer denied successfully",
        transfer: deniedTransfer,
      });
    } catch (error) {
      console.error("Error denying job seeker transfer:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to deny transfer",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async sendApprovalEmail(transfer) {
    if (!transfer.requested_by_email) return;
    const full = await this.transferModel.getById(transfer.id);
    const sourceName = full?.source_js_name || transfer.source_record_number || "";
    const targetName = full?.target_js_name || transfer.target_record_number || "";

    await sendMail({
      to: transfer.requested_by_email,
      subject: `Job Seeker Transfer Approved: ${transfer.source_record_number} → ${transfer.target_record_number}`,
      html: `
        <h2>Job Seeker Transfer Approved</h2>
        <p>Your job seeker transfer request has been approved and executed:</p>
        <ul>
          <li><strong>Source Job Seeker:</strong> ${sourceName} (${transfer.source_record_number}) - <strong>Archived</strong></li>
          <li><strong>Target Job Seeker:</strong> ${targetName} (${transfer.target_record_number})</li>
        </ul>
        <p><strong>What was transferred:</strong></p>
        <ul>
          <li>Notes</li>
          <li>Documents</li>
          <li>Tasks</li>
          <li>Placements</li>
          <li>Applications (merged into target)</li>
        </ul>
        <p>The source job seeker record has been archived.</p>
      `,
    });
  }

  async sendDenialEmail(transfer, denialReason) {
    if (!transfer.requested_by_email) return;
    const full = await this.transferModel.getById(transfer.id);
    const sourceName = full?.source_js_name || transfer.source_record_number || "";
    const targetName = full?.target_js_name || transfer.target_record_number || "";

    await sendMail({
      to: transfer.requested_by_email,
      subject: `Job Seeker Transfer Denied: ${transfer.source_record_number} → ${transfer.target_record_number}`,
      html: `
        <h2>Job Seeker Transfer Denied</h2>
        <p>Your job seeker transfer request has been denied:</p>
        <ul>
          <li><strong>Source:</strong> ${sourceName} (${transfer.source_record_number})</li>
          <li><strong>Target:</strong> ${targetName} (${transfer.target_record_number})</li>
          <li><strong>Denial Reason:</strong> ${denialReason}</li>
        </ul>
        <p>No changes have been made.</p>
      `,
    });
  }

  async executeJobSeekerTransfer(transfer) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const sourceId = transfer.source_job_seeker_id;
      const targetId = transfer.target_job_seeker_id;

      // 1. Transfer notes
      await client.query(
        "UPDATE job_seeker_notes SET job_seeker_id = $1 WHERE job_seeker_id = $2",
        [targetId, sourceId]
      );

      // 2. Transfer documents (entity_type = 'job_seeker')
      await client.query(
        "UPDATE documents SET entity_id = $1 WHERE entity_type = 'job_seeker' AND entity_id = $2",
        [targetId, sourceId]
      );

      // 3. Transfer tasks
      await client.query(
        "UPDATE tasks SET job_seeker_id = $1 WHERE job_seeker_id = $2",
        [targetId, sourceId]
      );

      // 4. Transfer placements
      await client.query(
        "UPDATE placements SET job_seeker_id = $1 WHERE job_seeker_id = $2",
        [targetId, sourceId]
      );

      // 5. Merge applications from source custom_fields into target custom_fields
      const sourceRow = await client.query(
        "SELECT custom_fields FROM job_seekers WHERE id = $1",
        [sourceId]
      );
      const targetRow = await client.query(
        "SELECT custom_fields FROM job_seekers WHERE id = $1",
        [targetId]
      );
      if (sourceRow.rows.length > 0 && targetRow.rows.length > 0) {
        const sourceCf = sourceRow.rows[0].custom_fields;
        const targetCf = targetRow.rows[0].custom_fields || {};
        const sourceParsed = typeof sourceCf === "string" ? JSON.parse(sourceCf || "{}") : (sourceCf || {});
        const targetParsed = typeof targetCf === "string" ? JSON.parse(targetCf || "{}") : (targetCf || {});
        const sourceApps = Array.isArray(sourceParsed.applications) ? sourceParsed.applications : [];
        const targetApps = Array.isArray(targetParsed.applications) ? targetParsed.applications : [];
        const merged = [...targetApps, ...sourceApps];
        const newTargetCf = { ...targetParsed, applications: merged };
        await client.query(
          "UPDATE job_seekers SET custom_fields = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
          [JSON.stringify(newTargetCf), targetId]
        );
      }

      // 6. Add notes to both job seekers
      await this.jobSeekerModel.addNote(
        sourceId,
        `Transfer approved: All data moved to ${transfer.target_record_number}. Status changed to Archived.`,
        transfer.approved_by
      );
      await this.jobSeekerModel.addNote(
        targetId,
        `Transfer approved: Received notes, documents, tasks, placements, and applications from ${transfer.source_record_number}.`,
        transfer.approved_by
      );

      // 7. Archive source job seeker (status = Archived, archive_reason = Transfer)
      await client.query(
        `UPDATE job_seekers
         SET status = 'Archived', archived_at = CURRENT_TIMESTAMP, archive_reason = 'Transfer', updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [sourceId]
      );

      // 8. Schedule cleanup (7 days)
      await client.query(
        `
        INSERT INTO scheduled_tasks (task_type, task_data, scheduled_for, status)
        VALUES ('archive_cleanup', $1::jsonb, CURRENT_TIMESTAMP + INTERVAL '7 days', 'pending')
      `,
        [JSON.stringify({ job_seeker_id: sourceId })]
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = JobSeekerTransferController;
