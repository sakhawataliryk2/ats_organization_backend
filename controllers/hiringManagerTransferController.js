// controllers/hiringManagerTransferController.js
const HiringManagerTransfer = require("../models/hiringManagerTransfer");
const HiringManager = require("../models/hiringManager");
const Organization = require("../models/organization");
const EmailTemplateModel = require("../models/emailTemplateModel");
const { renderTemplate } = require("../utils/templateRenderer");
const { sendMail } = require("../services/emailService");

const PAYROLL_EMAIL = process.env.PAYROLL_EMAIL || "payroll@completestaffingsolutions.com";
// const PAYROLL_EMAIL = "yasirrehman274@gmail.com";

class HiringManagerTransferController {
  constructor(pool) {
    this.pool = pool;
    this.transferModel = new HiringManagerTransfer(pool);
    this.hiringManagerModel = new HiringManager(pool);
    this.organizationModel = new Organization(pool);
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
        source_hiring_manager_id,
        target_hiring_manager_id,
        requested_by,
        requested_by_email,
        source_record_number,
        target_record_number,
      } = req.body;

      if (!source_hiring_manager_id || !target_hiring_manager_id) {
        return res.status(400).json({
          success: false,
          message: "Source and target hiring manager IDs are required",
        });
      }

      if (Number(source_hiring_manager_id) === Number(target_hiring_manager_id)) {
        return res.status(400).json({
          success: false,
          message: "Cannot transfer to the same hiring manager",
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
        source_hiring_manager_id: Number(source_hiring_manager_id),
        target_hiring_manager_id: Number(target_hiring_manager_id),
        requested_by: userId,
        requested_by_name: requester.name,
        requested_by_email: requester.email,
        source_record_number: source_record_number || null,
        target_record_number: target_record_number || null,
      });

      try {
        await this.sendTransferRequestEmail(transfer, requester);
      } catch (emailError) {
        console.error("Error sending hiring manager transfer request email:", emailError);
      }

      return res.status(201).json({
        success: true,
        message: "Hiring manager transfer request created successfully",
        transfer,
      });
    } catch (error) {
      console.error("Error creating hiring manager transfer:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to create transfer request",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async sendTransferRequestEmail(transfer, requester) {
    const baseUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const approvalUrl = `${baseUrl}/dashboard/hiring-managers/transfer/${transfer.id}/approve`;
    const denyUrl = `${baseUrl}/dashboard/hiring-managers/transfer/${transfer.id}/deny`;

    const templateType = "HIRING_MANAGER_TRANSFER_REQUEST";
    const tpl = await this.emailTemplateModel.getTemplateByType(templateType);

    const requestDate = new Date(transfer.created_at).toLocaleString();
    const approvalButtonHtml =
      `<a href="${approvalUrl}" style="display:inline-block;background-color:#4CAF50;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;margin-right:10px;">Approve Transfer</a>`;
    const denyButtonHtml =
      `<a href="${denyUrl}" style="display:inline-block;background-color:#f44336;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">Deny Transfer</a>`;

    const client = await this.pool.connect();
    let sourceName = "";
    let targetName = "";
    let sourceOrganizationNameLink = transfer.source_record_number || "";
    let targetOrganizationNameLink = transfer.target_record_number || "";
    try {
      const fullTransfer = await this.transferModel.getById(transfer.id);
      sourceName = fullTransfer?.source_hm_name || transfer.source_record_number || "";
      targetName = fullTransfer?.target_hm_name || transfer.target_record_number || "";
      const srcOrgId = fullTransfer?.source_organization_id;
      const tgtOrgId = fullTransfer?.target_organization_id;
      if (srcOrgId) {
        try {
          const org = await this.organizationModel.getById(srcOrgId);
          const name = org?.name || transfer.source_record_number || "";
          sourceOrganizationNameLink = `<a href="${baseUrl}/dashboard/organizations/view?id=${srcOrgId}" style="color:#2563eb;text-decoration:underline;">${name}</a>`;
        } catch (_) {}
      }
      if (tgtOrgId) {
        try {
          const org = await this.organizationModel.getById(tgtOrgId);
          const name = org?.name || transfer.target_record_number || "";
          targetOrganizationNameLink = `<a href="${baseUrl}/dashboard/organizations/view?id=${tgtOrgId}" style="color:#2563eb;text-decoration:underline;">${name}</a>`;
        } catch (_) {}
      }
    } finally {
      client.release();
    }

    const vars = {
      requestedBy: requester.name || "Unknown",
      requestedByEmail: requester.email || "",
      sourceRecordNumber: transfer.source_record_number || "",
      targetRecordNumber: transfer.target_record_number || "",
      sourceOrganizationNameLink,
      targetOrganizationNameLink,
      requestDate,
      approvalUrl,
      denyUrl,
    };
    const bodyVars = {
      ...vars,
      approvalUrl: approvalButtonHtml,
      denyUrl: denyButtonHtml,
    };
    const safeKeys = ["approvalUrl", "denyUrl", "sourceOrganizationNameLink", "targetOrganizationNameLink"];

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
        subject: `Hiring Manager Transfer Request: ${vars.sourceRecordNumber} → ${vars.targetRecordNumber}`,
        html: `
          <h2>Hiring Manager Transfer Request</h2>
          <p>A transfer request has been submitted (hiring manager to hiring manager):</p>
          <ul>
            <li><strong>Requested By:</strong> ${vars.requestedBy} (${vars.requestedByEmail})</li>
            <li><strong>Source Hiring Manager:</strong> ${sourceName} (${vars.sourceRecordNumber})</li>
            <li><strong>Target Hiring Manager:</strong> ${targetName} (${vars.targetRecordNumber})</li>
            <li><strong>Request Date:</strong> ${requestDate}</li>
          </ul>
          <p>If approved, notes, documents, tasks, and jobs linked to the source hiring manager will be moved to the target. The source hiring manager will be archived.</p>
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
      console.error("Error fetching hiring manager transfer:", error);
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
      await this.executeHiringManagerTransfer(approvedTransfer);

      try {
        await this.sendApprovalEmail(approvedTransfer);
      } catch (emailError) {
        console.error("Error sending approval email:", emailError);
      }

      return res.json({
        success: true,
        message: "Hiring manager transfer approved and executed successfully",
        transfer: approvedTransfer,
      });
    } catch (error) {
      console.error("Error approving hiring manager transfer:", error);
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
        await this.hiringManagerModel.addNote(
          transfer.source_hiring_manager_id,
          `Transfer denied: ${denial_reason.trim()}`,
          userId
        );
        await this.hiringManagerModel.addNote(
          transfer.target_hiring_manager_id,
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
      console.error("Error denying hiring manager transfer:", error);
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
    const sourceName = full?.source_hm_name || transfer.source_record_number || "";
    const targetName = full?.target_hm_name || transfer.target_record_number || "";

    await sendMail({
      to: transfer.requested_by_email,
      subject: `Hiring Manager Transfer Approved: ${transfer.source_record_number} → ${transfer.target_record_number}`,
      html: `
        <h2>Hiring Manager Transfer Approved</h2>
        <p>Your hiring manager transfer request has been approved and executed:</p>
        <ul>
          <li><strong>Source Hiring Manager:</strong> ${sourceName} (${transfer.source_record_number}) - <strong>Archived</strong></li>
          <li><strong>Target Hiring Manager:</strong> ${targetName} (${transfer.target_record_number})</li>
        </ul>
        <p><strong>What was transferred:</strong></p>
        <ul>
          <li>Notes</li>
          <li>Documents</li>
          <li>Tasks</li>
          <li>Jobs (linked to source hiring manager)</li>
        </ul>
        <p>The source hiring manager record has been archived.</p>
      `,
    });
  }

  async sendDenialEmail(transfer, denialReason) {
    if (!transfer.requested_by_email) return;
    const full = await this.transferModel.getById(transfer.id);
    const sourceName = full?.source_hm_name || transfer.source_record_number || "";
    const targetName = full?.target_hm_name || transfer.target_record_number || "";

    await sendMail({
      to: transfer.requested_by_email,
      subject: `Hiring Manager Transfer Denied: ${transfer.source_record_number} → ${transfer.target_record_number}`,
      html: `
        <h2>Hiring Manager Transfer Denied</h2>
        <p>Your hiring manager transfer request has been denied:</p>
        <ul>
          <li><strong>Source:</strong> ${sourceName} (${transfer.source_record_number})</li>
          <li><strong>Target:</strong> ${targetName} (${transfer.target_record_number})</li>
          <li><strong>Denial Reason:</strong> ${denialReason}</li>
        </ul>
        <p>No changes have been made.</p>
      `,
    });
  }

  async executeHiringManagerTransfer(transfer) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const sourceId = transfer.source_hiring_manager_id;
      const targetId = transfer.target_hiring_manager_id;

      const sourceResult = await client.query(
        "SELECT id, organization_id, first_name, last_name, CONCAT(last_name, ', ', first_name) as full_name FROM hiring_managers WHERE id = $1",
        [sourceId]
      );
      const targetResult = await client.query(
        "SELECT id, organization_id, first_name, last_name, CONCAT(last_name, ', ', first_name) as full_name FROM hiring_managers WHERE id = $1",
        [targetId]
      );

      if (sourceResult.rows.length === 0 || targetResult.rows.length === 0) {
        throw new Error("Source or target hiring manager not found");
      }

      const sourceHm = sourceResult.rows[0];
      const targetHm = targetResult.rows[0];

      // 1. Transfer notes
      await client.query(
        "UPDATE hiring_manager_notes SET hiring_manager_id = $1 WHERE hiring_manager_id = $2",
        [targetId, sourceId]
      );

      // 2. Transfer documents (entity_type = 'hiring_manager')
      await client.query(
        "UPDATE documents SET entity_id = $1 WHERE entity_type = 'hiring_manager' AND entity_id = $2",
        [targetId, sourceId]
      );

      // 3. Transfer tasks
      await client.query(
        "UPDATE tasks SET hiring_manager_id = $1 WHERE hiring_manager_id = $2",
        [targetId, sourceId]
      );

      // 4. Transfer jobs: jobs with same org as source HM and hiring_manager text matching source HM full_name
      // Update to target HM's org and target HM's full_name
      await client.query(
        `UPDATE jobs
         SET organization_id = $1, hiring_manager = $2, updated_at = CURRENT_TIMESTAMP
         WHERE organization_id = $3 AND TRIM(COALESCE(hiring_manager, '')) = $4`,
        [
          targetHm.organization_id,
          targetHm.full_name,
          sourceHm.organization_id,
          sourceHm.full_name || "",
        ]
      );

      // 5. Add notes to both hiring managers
      await this.hiringManagerModel.addNote(
        sourceId,
        `Transfer approved: All data moved to ${transfer.target_record_number}. Status changed to Archived.`,
        transfer.approved_by
      );
      await this.hiringManagerModel.addNote(
        targetId,
        `Transfer approved: Received notes, documents, tasks, and jobs from ${transfer.source_record_number}.`,
        transfer.approved_by
      );

      // 6. Archive source hiring manager (status = Archived, archive_reason = Transfer)
      await client.query(
        `UPDATE hiring_managers
         SET status = 'Archived', archived_at = CURRENT_TIMESTAMP, archive_reason = 'Transfer', updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [sourceId]
      );

      // 7. Schedule cleanup (7 days)
      await client.query(
        `
        INSERT INTO scheduled_tasks (task_type, task_data, scheduled_for, status)
        VALUES ('archive_cleanup', $1::jsonb, CURRENT_TIMESTAMP + INTERVAL '7 days', 'pending')
      `,
        [JSON.stringify({ hiring_manager_id: sourceId })]
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

module.exports = HiringManagerTransferController;
