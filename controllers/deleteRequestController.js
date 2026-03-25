const DeleteRequest = require("../models/deleteRequest");
const UnarchiveRequest = require("../models/unarchiveRequest");
const Organization = require("../models/organization");
const HiringManager = require("../models/hiringManager");
const JobSeeker = require("../models/jobseeker");
const Job = require("../models/job");
const Lead = require("../models/lead");
const Task = require("../models/task");
const Placement = require("../models/placement");
const EmailTemplateModel = require("../models/emailTemplateModel");
const { renderTemplate } = require("../utils/templateRenderer");
const { sendMail } = require("../services/emailService");

const PAYROLL_EMAIL = process.env.PAYROLL_EMAIL || "nt50616849@gmail.com";
// const PAYROLL_EMAIL = "yasirrehman274@gmail.com";
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";

let scheduledTasksTableInitialized = false;
let deleteRequestTablesInitialized = false;

// Optional escalation: when retry_count >= threshold, notify escalation email and add [ESCALATED] to subject
const ESCALATION_ENABLED = process.env.DELETE_REQUEST_ESCALATION_ENABLED === "true";
const ESCALATION_EMAIL = process.env.DELETE_REQUEST_ESCALATION_EMAIL || null;
const ESCALATION_AFTER_RETRIES = parseInt(process.env.DELETE_REQUEST_ESCALATION_AFTER_RETRIES || "3", 10);

class DeleteRequestController {
  constructor(pool) {
    this.pool = pool;
    this.deleteRequestModel = new DeleteRequest(pool);
    this.unarchiveRequestModel = new UnarchiveRequest(pool);
    this.organizationModel = new Organization(pool);
    this.hiringManagerModel = new HiringManager(pool);
    this.jobSeekerModel = new JobSeeker(pool);
    this.jobModel = new Job(pool);
    this.leadModel = new Lead(pool);
    this.taskModel = new Task(pool);
    this.placementModel = new Placement(pool);
    this.emailTemplateModel = new EmailTemplateModel(pool);
    this.create = this.create.bind(this);
    this.approve = this.approve.bind(this);
    this.deny = this.deny.bind(this);
    this.getByRecord = this.getByRecord.bind(this);
    this.getById = this.getById.bind(this);
    this.sendUnarchiveRequest = this.sendUnarchiveRequest.bind(this);
    this.getUnarchiveRequestById = this.getUnarchiveRequestById.bind(this);
    this.approveUnarchive = this.approveUnarchive.bind(this);
    this.denyUnarchive = this.denyUnarchive.bind(this);
  }

  async initTables() {
    if (deleteRequestTablesInitialized) return;
    try {
      console.log('Initializing delete request tables...');
      await this.deleteRequestModel.initTable();
      console.log('✅ Delete request tables initialized');
      deleteRequestTablesInitialized = true;
    } catch (error) {
      console.error('❌ Error initializing delete request tables:', error);
      throw error;
    }
  }

  /** Ensure scheduled_tasks table exists (used for archive cleanup jobs). No-op after first run per process. */
  async ensureScheduledTasksTable() {
    if (scheduledTasksTableInitialized) return;
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS scheduled_tasks (
          id SERIAL PRIMARY KEY,
          task_type VARCHAR(100) NOT NULL,
          task_data JSONB,
          scheduled_for TIMESTAMP NOT NULL,
          status VARCHAR(50) DEFAULT 'pending',
          completed_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      scheduledTasksTableInitialized = true;
    } finally {
      client.release();
    }
  }

  async create(req, res) {
    try {
      // Ensure table is initialized before creating delete request
      await this.initTables();
      
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      const { id } = req.params; // organization ID
      const { 
        reason, 
        record_type, 
        record_number, 
        requested_by, 
        requested_by_email,
        action_type = 'standard',
        dependencies_summary = null,
        user_consent = false
      } = req.body;

      if (!reason || !reason.trim()) {
        return res.status(400).json({
          success: false,
          message: "Reason for deletion is required",
        });
      }

      // Validate action_type
      if (action_type !== 'standard' && action_type !== 'cascade') {
        return res.status(400).json({
          success: false,
          message: "action_type must be either 'standard' or 'cascade'",
        });
      }

      // If cascade deletion, validate dependencies_summary and user_consent
      if (action_type === 'cascade') {
        if (!dependencies_summary || typeof dependencies_summary !== 'object') {
          return res.status(400).json({
            success: false,
            message: "dependencies_summary is required for cascade deletion",
          });
        }
        if (!user_consent) {
          return res.status(400).json({
            success: false,
            message: "User consent is required for cascade deletion",
          });
        }
      }

      // For standard deletion, check if dependencies exist and force cascade if they do
      if (action_type === 'standard' && record_type === 'organization') {
        const dependencyCounts = await this.organizationModel.getDependencyCounts(id);
        const hasDependencies = (
          (dependencyCounts.hiring_managers > 0) ||
          (dependencyCounts.jobs > 0) ||
          (dependencyCounts.placements > 0) ||
          (dependencyCounts.child_organizations > 0)
        );
        
        if (hasDependencies) {
          return res.status(400).json({
            success: false,
            message: "This organization has linked records. Please use cascade deletion or transfer records first.",
            dependencyCounts,
          });
        }
      }

      // Check if there's already a pending request
      const existingRequest = await this.deleteRequestModel.getByRecord(id, record_type || "organization");
      if (existingRequest && existingRequest.status === "pending") {
        return res.status(400).json({
          success: false,
          message: "A delete request is already pending for this record",
        });
      }

      // Get user info
      const client = await this.organizationModel.pool.connect();
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

      // Create delete request
      const deleteRequest = await this.deleteRequestModel.create({
        record_id: id,
        record_type: record_type || "organization",
        record_number: record_number || null,
        requested_by: userId,
        requested_by_name: requested_by || user.name || "Unknown",
        requested_by_email: requested_by_email || user.email || "",
        reason: reason.trim(),
        action_type,
        dependencies_summary,
        user_consent,
      });

      // Set record status to pending_archive_approval (archive workflow)
      try {
        await this.setRecordPendingArchive(record_type || "organization", id);
      } catch (pendingErr) {
        console.error("Error setting record to pending_archive_approval:", pendingErr);
        // Don't fail the request; record may not have status column in some envs
      }

      // Send email notification to payroll
      try {
        await this.sendDeleteRequestEmail(deleteRequest, {
          name: requested_by || user.name || "Unknown",
          email: requested_by_email || user.email || "",
        });
      } catch (emailError) {
        console.error("Error sending delete request email:", emailError);
        // Don't fail the request if email fails
      }

      return res.status(201).json({
        success: true,
        message: "Delete request created successfully",
        deleteRequest,
      });
    } catch (error) {
      console.error("Error creating delete request:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to create delete request",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async sendDeleteRequestEmail(deleteRequest, requester, options = {}) {
    const baseUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    let recordPath = "organizations";
    if (deleteRequest.record_type === "hiring_manager") {
      recordPath = "hiring-managers";
    } else if (deleteRequest.record_type === "job_seeker") {
      recordPath = "job-seekers";
    } else if (deleteRequest.record_type === "job") {
      recordPath = "jobs";
    } else if (deleteRequest.record_type === "lead") {
      recordPath = "leads";
    } else if (deleteRequest.record_type === "task") {
      recordPath = "tasks";
    } else if (deleteRequest.record_type === "placement") {
      recordPath = "placements";
    }
    const approvalUrl = `${baseUrl}/dashboard/${recordPath}/delete/${deleteRequest.id}/approve`;
    const denyUrl = `${baseUrl}/dashboard/${recordPath}/delete/${deleteRequest.id}/deny`;

    let templateType = "ORGANIZATION_DELETE_REQUEST";
    if (deleteRequest.record_type === "hiring_manager") {
      templateType = "HIRING_MANAGER_DELETE_REQUEST";
    } else if (deleteRequest.record_type === "job_seeker") {
      templateType = "JOB_SEEKER_DELETE_REQUEST";
    } else if (deleteRequest.record_type === "job") {
      templateType = "JOB_DELETE_REQUEST";
    } else if (deleteRequest.record_type === "lead") {
      templateType = "LEAD_DELETE_REQUEST";
    } else if (deleteRequest.record_type === "task") {
      templateType = "TASK_DELETE_REQUEST";
    } else if (deleteRequest.record_type === "placement") {
      templateType = "PLACEMENT_DELETE_REQUEST";
    }
    const tpl = await this.emailTemplateModel.getTemplateByType(templateType);

    const requestDate = new Date(deleteRequest.created_at).toLocaleString();
    const approvalButtonHtml =
      `<a href="${approvalUrl}" style="display:inline-block;background-color:#4CAF50;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;margin-right:10px;">Approve Deletion</a>`;
    const denyButtonHtml =
      `<a href="${denyUrl}" style="display:inline-block;background-color:#f44336;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">Deny Deletion</a>`;

    const recordDisplay = String(deleteRequest.record_number || deleteRequest.record_id);
    const isCascade = deleteRequest.action_type === 'cascade';
    const dependencies = deleteRequest.dependencies_summary || {};
    const retryCount = deleteRequest.retry_count ?? options.retryCount ?? 0;
    const isEscalation = options.isEscalation ?? (ESCALATION_ENABLED && ESCALATION_EMAIL && retryCount >= ESCALATION_AFTER_RETRIES);
    const escalationPrefix = isEscalation ? "[ESCALATED] " : "";

    let organizationNameLink = recordDisplay;
    const buildOrgLink = (orgId, orgName, fallback) => {
      if (!orgId) return fallback || recordDisplay;
      const name = orgName || fallback || recordDisplay;
      const recordUrl = `${baseUrl}/dashboard/organizations/view?id=${orgId}`;
      return `<a href="${recordUrl}" style="color:#2563eb;text-decoration:underline;">${name}</a>`;
    };
    try {
      if (deleteRequest.record_type === "organization") {
        const org = await this.organizationModel.getById(deleteRequest.record_id);
        organizationNameLink = buildOrgLink(deleteRequest.record_id, org?.name, recordDisplay);
      } else if (deleteRequest.record_type === "hiring_manager") {
        const hm = await this.hiringManagerModel.getById(deleteRequest.record_id);
        const orgId = hm?.organization_id;
        if (orgId) {
          const org = await this.organizationModel.getById(orgId);
          organizationNameLink = buildOrgLink(orgId, org?.name, recordDisplay);
        }
      } else if (deleteRequest.record_type === "job") {
        const job = await this.jobModel.getById(deleteRequest.record_id);
        const orgId = job?.organization_id;
        if (orgId) {
          const org = await this.organizationModel.getById(orgId);
          organizationNameLink = buildOrgLink(orgId, org?.name, recordDisplay);
        }
      } else if (deleteRequest.record_type === "lead") {
        const lead = await this.leadModel.getById(deleteRequest.record_id);
        const orgId = lead?.organization_id;
        if (orgId) {
          const org = await this.organizationModel.getById(orgId);
          organizationNameLink = buildOrgLink(orgId, org?.name, recordDisplay);
        }
      } else if (deleteRequest.record_type === "task") {
        const task = await this.taskModel.getById(deleteRequest.record_id);
        const orgId = task?.organization_id;
        if (orgId) {
          const org = await this.organizationModel.getById(orgId);
          organizationNameLink = buildOrgLink(orgId, org?.name, recordDisplay);
        }
      } else if (deleteRequest.record_type === "placement") {
        const placement = await this.placementModel.findById(deleteRequest.record_id);
        const orgId = placement?.organizationId ?? placement?.organization_id;
        if (orgId) {
          const org = await this.organizationModel.getById(orgId);
          organizationNameLink = buildOrgLink(orgId, org?.name, recordDisplay);
        }
      } else if (deleteRequest.record_type === "job_seeker") {
        const placements = await this.placementModel.findByJobSeekerId(deleteRequest.record_id);
        const first = placements?.[0];
        const orgId = first?.organizationId ?? first?.organization_id;
        if (orgId) {
          const org = await this.organizationModel.getById(orgId);
          organizationNameLink = buildOrgLink(orgId, org?.name, recordDisplay);
        }
      }
    } catch (err) {
      console.error("Error fetching organization for email:", err);
    }

    const vars = {
      requestedBy: requester.name || "Unknown",
      requestedByEmail: requester.email || "",
      recordType: deleteRequest.record_type,
      recordNumber: recordDisplay,
      organizationNameLink,
      requestId: String(deleteRequest.id),
      reason: deleteRequest.reason || "",
      requestDate,
      approvalUrl,
      denyUrl,
      isCascade: isCascade ? 'true' : 'false',
      cascadeWarning: isCascade ? '⚠️ CASCADE DELETION REQUEST - This will delete the organization AND all linked records.' : '',
      dependenciesList: isCascade ? this.formatDependenciesList(dependencies) : '',
    };
    const bodyVars = {
      ...vars,
      approvalUrl: approvalButtonHtml,
      denyUrl: denyButtonHtml,
    };
    const safeKeys = ["approvalUrl", "denyUrl", "organizationNameLink"];

    // Job seeker delete requests go to onboarding; all others use payroll
    const baseRecipient = deleteRequest.record_type === "job_seeker"
      ? "onboarding@completestaffingsolutions.com"
      : PAYROLL_EMAIL;
    const recipients = isEscalation && ESCALATION_EMAIL
      ? [baseRecipient, ESCALATION_EMAIL].filter(Boolean).join(", ")
      : baseRecipient;

    if (tpl) {
      const subject = escalationPrefix + renderTemplate(tpl.subject, vars, safeKeys);
      let html = renderTemplate(tpl.body, bodyVars, safeKeys);
      html = html.replace(/\r\n/g, "\n").replace(/\n/g, "<br/>");
      if (isEscalation) {
        html = `<div style="background:#fff3cd;border:2px solid #ffc107;padding:10px;margin-bottom:15px;border-radius:5px;"><strong>⚠️ ESCALATED</strong> - This request has been pending through ${retryCount} retry cycle(s) and requires urgent attention.</div>${html}`;
      }
      await sendMail({
        to: recipients,
        subject,
        html,
      });
    } else {
      const subjectPrefix = escalationPrefix + (isCascade ? '⚠️ Cascade Deletion Request: ' : 'Delete Request: ');
      const cascadeSection = isCascade ? `
        <div style="background-color: #fee; border: 2px solid #f44; padding: 15px; margin: 15px 0; border-radius: 5px;">
          <h3 style="color: #c00; margin-top: 0;">⚠️ CASCADE DELETION WARNING</h3>
          <p style="color: #800; font-weight: bold;">This request will delete the organization AND the following linked records:</p>
          <ul style="color: #800;">
            ${dependencies.hiring_managers > 0 ? `<li><strong>${dependencies.hiring_managers}</strong> Hiring Managers</li>` : ''}
            ${dependencies.jobs > 0 ? `<li><strong>${dependencies.jobs}</strong> Jobs</li>` : ''}
            ${dependencies.placements > 0 ? `<li><strong>${dependencies.placements}</strong> Placements</li>` : ''}
            ${dependencies.child_organizations > 0 ? `<li><strong>${dependencies.child_organizations}</strong> Child Organizations</li>` : ''}
          </ul>
          <p style="color: #800; font-weight: bold;">User has explicitly consented to this cascade deletion.</p>
        </div>
      ` : '';

      let fallbackHtml = `
        <h2>${isCascade ? '⚠️ Cascade ' : ''}Delete Request</h2>
        <p>A new ${deleteRequest.record_type} delete request has been submitted and requires your review.</p>
        ${cascadeSection}
        <p><strong>Request Details:</strong></p>
        <ul>
          <li><strong>Request ID:</strong> ${vars.requestId} (this ID is used in the approval link)</li>
          <li><strong>Record (${deleteRequest.record_type}):</strong> ${recordDisplay}</li>
          <li><strong>Request Type:</strong> ${isCascade ? 'Cascade Deletion' : 'Standard Deletion'}</li>
          <li><strong>Requested By:</strong> ${vars.requestedBy} (${vars.requestedByEmail})</li>
          <li><strong>Request Date:</strong> ${requestDate}</li>
          <li><strong>Reason:</strong> ${vars.reason}</li>
        </ul>
        <p>Please review the request and take the appropriate action using the links below:</p>
        <p>
          <a href="${approvalUrl}" style="background-color: ${isCascade ? '#c00' : '#4CAF50'}; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-right: 10px;">${isCascade ? 'Approve Cascade Deletion' : 'Approve Deletion'}</a>
          <a href="${denyUrl}" style="background-color: #f44336; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Deny Deletion</a>
        </p>
      `;
      if (isEscalation) {
        fallbackHtml = `<div style="background:#fff3cd;border:2px solid #ffc107;padding:10px;margin-bottom:15px;border-radius:5px;"><strong>⚠️ ESCALATED</strong> - This request has been pending through ${retryCount} retry cycle(s) and requires urgent attention.</div>${fallbackHtml}`;
      }
      await sendMail({
        to: recipients,
        subject: `${subjectPrefix}${deleteRequest.record_type} ${recordDisplay}`,
        html: fallbackHtml,
      });
    }
  }

  async getByRecord(req, res) {
    try {
      const { id } = req.params;
      const recordType = req.query.record_type || "organization";

      const deleteRequest = await this.deleteRequestModel.getByRecord(id, recordType);

      return res.json({
        success: true,
        deleteRequest,
      });
    } catch (error) {
      console.error("Error fetching delete request:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch delete request",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async getById(req, res) {
    try {
      const { id } = req.params;

      const deleteRequest = await this.deleteRequestModel.getById(id);
      if (!deleteRequest) {
        return res.status(404).json({
          success: false,
          message: "Delete request not found",
        });
      }

      const payload = { success: true, deleteRequest };
      if (deleteRequest.status === "expired") {
        payload.message = "This delete request session has expired.";
      }
      return res.json(payload);
    } catch (error) {
      console.error("Error fetching delete request:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch delete request",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async approve(req, res) {
    try {
      // Only ensure delete_requests table; other tables are initialized in executeDeletion per record_type
      await this.initTables();

      const userId = req.user?.id;
      const { id } = req.params;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      const deleteRequest = await this.deleteRequestModel.getById(id);
      if (!deleteRequest) {
        return res.status(404).json({
          success: false,
          message: "Delete request not found",
        });
      }

      if (deleteRequest.status !== "pending") {
        const recordDisplay = deleteRequest.record_number || deleteRequest.record_id;
        const message =
          deleteRequest.status === "expired"
            ? "This delete request session has expired."
            : `Delete request for ${deleteRequest.record_type} ${recordDisplay} has already been ${deleteRequest.status}. The record may already be archived.`;
        return res.status(400).json({
          success: false,
          message,
        });
      }

      // Execute the deletion (archive the record) FIRST, then mark as approved.
      // This way if executeDeletion fails (e.g. timeout), the request stays pending and can be retried.
      const requestWithReviewer = { ...deleteRequest, reviewed_by: userId };
      await this.executeDeletion(requestWithReviewer);

      // Now mark the delete request as approved
      const approvedRequest = await this.deleteRequestModel.approve(id, userId);

      // Respond immediately so UI doesn't hang; send approval email in background
      res.json({
        success: true,
        message: "Delete request approved and record archived successfully",
        deleteRequest: approvedRequest,
      });

      this.sendApprovalEmail(approvedRequest).catch((emailError) => {
        console.error("Error sending approval email:", emailError);
      });
    } catch (error) {
      console.error("Error approving delete request:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to approve delete request",
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

      const deleteRequest = await this.deleteRequestModel.getById(id);
      if (!deleteRequest) {
        return res.status(404).json({
          success: false,
          message: "Delete request not found",
        });
      }

      if (deleteRequest.status !== "pending") {
        const message =
          deleteRequest.status === "expired"
            ? "This delete request session has expired."
            : `Delete request is already ${deleteRequest.status}`;
        return res.status(400).json({
          success: false,
          message,
        });
      }

      // Deny the delete request
      const deniedRequest = await this.deleteRequestModel.deny(
        id,
        denial_reason.trim(),
        userId
      );

      // Restore record status to active (was pending_archive_approval)
      try {
        await this.restoreRecordStatusAfterDeny(deniedRequest.record_type, deniedRequest.record_id);
      } catch (restoreErr) {
        console.error("Error restoring record status after deny:", restoreErr);
      }

      // Add denial reason as note to the record
      try {
        if (deniedRequest.record_type === "organization") {
          await this.organizationModel.addNote(
            deniedRequest.record_id,
            `Delete denied: ${denial_reason.trim()}`,
            userId
          );
        } else if (deniedRequest.record_type === "hiring_manager") {
          await this.hiringManagerModel.addNote(
            deniedRequest.record_id,
            `Delete denied: ${denial_reason.trim()}`,
            userId
          );
        } else if (deniedRequest.record_type === "job_seeker") {
          await this.jobSeekerModel.addNote(
            deniedRequest.record_id,
            `Delete denied: ${denial_reason.trim()}`,
            userId
          );
        } else if (deniedRequest.record_type === "job") {
          await this.jobModel.addNote(
            deniedRequest.record_id,
            `Delete denied: ${denial_reason.trim()}`,
            userId
          );
        } else if (deniedRequest.record_type === "lead") {
          await this.leadModel.addNote(
            deniedRequest.record_id,
            `Delete denied: ${denial_reason.trim()}`,
            userId
          );
        } else if (deniedRequest.record_type === "task") {
          await this.taskModel.addNote(
            deniedRequest.record_id,
            `Delete denied: ${denial_reason.trim()}`,
            userId
          );
        } else if (deniedRequest.record_type === "placement") {
          await this.placementModel.addNote(
            deniedRequest.record_id,
            `Delete denied: ${denial_reason.trim()}`,
            userId
          );
        }
      } catch (noteError) {
        console.error("Error adding denial note:", noteError);
      }

      // Send denial email to requester
      try {
        await this.sendDenialEmail(deniedRequest, denial_reason.trim());
      } catch (emailError) {
        console.error("Error sending denial email:", emailError);
      }

      return res.json({
        success: true,
        message: "Delete request denied successfully",
        deleteRequest: deniedRequest,
      });
    } catch (error) {
      console.error("Error denying delete request:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to deny delete request",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async sendApprovalEmail(deleteRequest) {
    if (!deleteRequest.requested_by_email) return;
    await sendMail({
      to: deleteRequest.requested_by_email,
      subject: `Delete Request Approved: ${deleteRequest.record_type} ${deleteRequest.record_number || deleteRequest.record_id}`,
      html: `
        <h2>Delete Request Approved</h2>
        <p>Your delete request has been approved:</p>
        <ul>
          <li><strong>Record Type:</strong> ${deleteRequest.record_type}</li>
          <li><strong>Record Number:</strong> ${deleteRequest.record_number || deleteRequest.record_id}</li>
          <li><strong>Reason:</strong> ${deleteRequest.reason}</li>
        </ul>
        <p>The record has been archived and will be permanently deleted after 7 days.</p>
      `,
    });
  }

  async sendDenialEmail(deleteRequest, denialReason) {
    if (!deleteRequest.requested_by_email) return;
    await sendMail({
      to: deleteRequest.requested_by_email,
      subject: `Delete Request Denied: ${deleteRequest.record_type} ${deleteRequest.record_number || deleteRequest.record_id}`,
      html: `
        <h2>Delete Request Denied</h2>
        <p>Your delete request has been denied:</p>
        <ul>
          <li><strong>Record Type:</strong> ${deleteRequest.record_type}</li>
          <li><strong>Record Number:</strong> ${deleteRequest.record_number || deleteRequest.record_id}</li>
          <li><strong>Denial Reason:</strong> ${denialReason}</li>
        </ul>
        <p>The record remains active and unchanged.</p>
      `,
    });
  }

  formatDependenciesList(dependencies) {
    const items = [];
    if (dependencies.hiring_managers > 0) {
      items.push(`${dependencies.hiring_managers} Hiring Managers`);
    }
    if (dependencies.jobs > 0) {
      items.push(`${dependencies.jobs} Jobs`);
    }
    if (dependencies.placements > 0) {
      items.push(`${dependencies.placements} Placements`);
    }
    if (dependencies.child_organizations > 0) {
      items.push(`${dependencies.child_organizations} Child Organizations`);
    }
    return items.length > 0 ? items.join(', ') : 'None';
  }

  async executeDeletion(deleteRequest) {
    // Only ensure scheduled_tasks exists (needed for cleanup jobs). Record-specific tables are inited per branch.
    await this.ensureScheduledTasksTable();

    const client = await this.organizationModel.pool.connect();
    try {
      await client.query("BEGIN");

      if (deleteRequest.record_type === "organization") {
        await this.organizationModel.initTable();
        // Check if this is a cascade deletion
        const isCascade = deleteRequest.action_type === 'cascade';
        
        if (isCascade) {
          // Get child organizations before archiving
          // parent_organization is VARCHAR(255), so compare as text
          // id is INTEGER, so compare as integer
          const recordId = typeof deleteRequest.record_id === 'string' ? parseInt(deleteRequest.record_id, 10) : deleteRequest.record_id;
          const recordIdStr = String(recordId);
          const childOrgsQuery = await client.query(
            `
            SELECT id FROM organizations 
            WHERE parent_organization = $1 
            AND status != 'Archived' 
            AND id != $2
            `,
            [recordIdStr, recordId]
          );
          const childOrgIds = childOrgsQuery.rows.map(row => row.id);

          // Use archiveCascade method to archive org and all dependencies
          await this.organizationModel.archiveCascade(
            deleteRequest.record_id,
            deleteRequest.reviewed_by,
            'Cascade Deletion'
          );

          // Add system note
          await this.organizationModel.addNote(
            deleteRequest.record_id,
            "Organization and all linked records archived following payroll approval (Cascade Deletion)",
            deleteRequest.reviewed_by
          );

          // Auto-approve pending delete requests for child organizations
          if (childOrgIds.length > 0) {
            for (const childOrgId of childOrgIds) {
              try {
                const childDeleteRequest = await this.deleteRequestModel.getByRecord(
                  childOrgId,
                  'organization'
                );
                
                if (childDeleteRequest && childDeleteRequest.status === 'pending') {
                  console.log(`Auto-approving child organization delete request: ${childDeleteRequest.id}`);
                  
                  // Approve the child delete request
                  const approvedChildRequest = await this.deleteRequestModel.approve(
                    childDeleteRequest.id,
                    deleteRequest.reviewed_by
                  );

                  // Execute deletion for child (standard archive since parent cascade handles dependencies)
                  await client.query(
                    `
                    UPDATE organizations
                    SET status = 'Archived',
                        archived_at = CURRENT_TIMESTAMP,
                        archive_reason = 'Deletion',
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = $1
                  `,
                    [childOrgId]
                  );

                  // Add system note to child org
                  await this.organizationModel.addNote(
                    childOrgId,
                    `Record archived following auto-approval (parent organization cascade deletion approved)`,
                    deleteRequest.reviewed_by
                  );

                  // Schedule cleanup job for child org
                  await client.query(
                    `
                    INSERT INTO scheduled_tasks (
                      task_type,
                      task_data,
                      scheduled_for,
                      status
                    ) VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP + INTERVAL '7 days', 'pending')
                  `,
                    [
                      "archive_cleanup",
                      JSON.stringify({
                        organization_id: childOrgId,
                        delete_request_id: approvedChildRequest.id,
                      }),
                    ]
                  );

                  // Send approval email for child org deletion
                  try {
                    await this.sendApprovalEmail(approvedChildRequest);
                  } catch (emailError) {
                    console.error(`Error sending approval email for child org ${childOrgId}:`, emailError);
                  }
                }
              } catch (childError) {
                console.error(`Error auto-approving child organization ${childOrgId}:`, childError);
                // Continue with other child orgs even if one fails
              }
            }
          }
        } else {
          // Standard deletion - only archive the organization
          await client.query(
            `
            UPDATE organizations
            SET status = 'Archived',
                archived_at = CURRENT_TIMESTAMP,
                archive_reason = 'Deletion',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
          `,
            [deleteRequest.record_id]
          );

          // Add system note
          await this.organizationModel.addNote(
            deleteRequest.record_id,
            "Record archived following payroll approval",
            deleteRequest.reviewed_by
          );
        }

        // Schedule cleanup job (7 days from now)
        await client.query(
          `
          INSERT INTO scheduled_tasks (
            task_type,
            task_data,
            scheduled_for,
            status
          ) VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP + INTERVAL '7 days', 'pending')
        `,
          [
            "archive_cleanup",
            JSON.stringify({
              organization_id: deleteRequest.record_id,
              delete_request_id: deleteRequest.id,
            }),
          ]
        );
      } else if (deleteRequest.record_type === "hiring_manager") {
        await this.hiringManagerModel.initTable();
        // Update hiring manager status to "Archived" and set archive_reason for Deletion
        await client.query(
          `
          UPDATE hiring_managers
          SET status = 'Archived',
              archived_at = CURRENT_TIMESTAMP,
              archive_reason = 'Deletion',
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `,
          [deleteRequest.record_id]
        );

        // Add system note
        await this.hiringManagerModel.addNote(
          deleteRequest.record_id,
          "Record archived following payroll approval",
          deleteRequest.reviewed_by
        );

        // Schedule cleanup job (7 days from now)
        await client.query(
          `
          INSERT INTO scheduled_tasks (
            task_type,
            task_data,
            scheduled_for,
            status
          ) VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP + INTERVAL '7 days', 'pending')
        `,
          [
            "archive_cleanup",
            JSON.stringify({
              hiring_manager_id: deleteRequest.record_id,
              delete_request_id: deleteRequest.id,
            }),
          ]
        );
      } else if (deleteRequest.record_type === "job_seeker") {
        await this.jobSeekerModel.initTable();
        await client.query(
          `
          UPDATE job_seekers
          SET status = 'Archived',
              archived_at = CURRENT_TIMESTAMP,
              archive_reason = 'Deletion',
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `,
          [deleteRequest.record_id]
        );

        // Match job deletion behavior: write the archive note within the same transaction
        await client.query(
          `
          INSERT INTO job_seeker_notes (job_seeker_id, text, note_type, created_by)
          VALUES ($1, $2, $3, $4)
        `,
          [
            deleteRequest.record_id,
            "Record archived following payroll approval",
            "General Note",
            deleteRequest.reviewed_by,
          ]
        );

        await client.query(
          `
          INSERT INTO scheduled_tasks (
            task_type,
            task_data,
            scheduled_for,
            status
          ) VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP + INTERVAL '7 days', 'pending')
        `,
          [
            "archive_cleanup",
            JSON.stringify({
              job_seeker_id: deleteRequest.record_id,
              delete_request_id: deleteRequest.id,
            }),
          ]
        );
      } else if (deleteRequest.record_type === "job") {
        await this.jobModel.initTable();
        // Update job status to "Archived" and set archived_at timestamp
        await client.query(
          `
          UPDATE jobs
          SET status = 'Archived',
              archived_at = CURRENT_TIMESTAMP,
              archive_reason = 'Deletion',
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `,
          [deleteRequest.record_id]
        );

        // Add note within the same transaction to avoid deadlock
        await client.query(
          `
          INSERT INTO job_notes (job_id, text, created_by)
          VALUES ($1, $2, $3)
        `,
          [
            deleteRequest.record_id,
            "Record archived following payroll approval",
            deleteRequest.reviewed_by
          ]
        );

        // When a job is archived via delete approval, remove all linked job seeker applications
        // for that job (so candidates are fully removed from that job’s pipeline).
        await client.query(
          `
          DELETE FROM job_seeker_applications
          WHERE job_id = $1
        `,
          [deleteRequest.record_id]
        );

        await client.query(
          `
          INSERT INTO scheduled_tasks (
            task_type,
            task_data,
            scheduled_for,
            status
          ) VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP + INTERVAL '7 days', 'pending')
        `,
          [
            "archive_cleanup",
            JSON.stringify({
              job_id: deleteRequest.record_id,
              delete_request_id: deleteRequest.id,
            }),
          ]
        );
      } else if (deleteRequest.record_type === "lead") {
        await this.leadModel.initTable();
        // Update lead status to "Archived" and set archived_at timestamp
        await client.query(
          `
          UPDATE leads
          SET status = 'Archived',
              archived_at = CURRENT_TIMESTAMP,
              archive_reason = 'Deletion',
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `,
          [deleteRequest.record_id]
        );

        // Add note within the same transaction to avoid deadlock
        await client.query(
          `
          INSERT INTO lead_notes (lead_id, text, created_by)
          VALUES ($1, $2, $3)
        `,
          [
            deleteRequest.record_id,
            "Record archived following payroll approval",
            deleteRequest.reviewed_by
          ]
        );

        await client.query(
          `
          INSERT INTO scheduled_tasks (
            task_type,
            task_data,
            scheduled_for,
            status
          ) VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP + INTERVAL '7 days', 'pending')
        `,
          [
            "archive_cleanup",
            JSON.stringify({
              lead_id: deleteRequest.record_id,
              delete_request_id: deleteRequest.id,
            }),
          ]
        );
      } else if (deleteRequest.record_type === "task") {
        await this.taskModel.initTable();
        // Update task status to "Archived" and set archived_at timestamp
        await client.query(
          `
          UPDATE tasks
          SET status = 'Archived',
              archived_at = CURRENT_TIMESTAMP,
              archive_reason = 'Deletion',
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `,
          [deleteRequest.record_id]
        );

        // Add note within the same transaction to avoid deadlock
        await client.query(
          `
          INSERT INTO task_notes (task_id, text, created_by)
          VALUES ($1, $2, $3)
        `,
          [
            deleteRequest.record_id,
            "Record archived following payroll approval",
            deleteRequest.reviewed_by
          ]
        );

        await client.query(
          `
          INSERT INTO scheduled_tasks (
            task_type,
            task_data,
            scheduled_for,
            status
          ) VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP + INTERVAL '7 days', 'pending')
        `,
          [
            "archive_cleanup",
            JSON.stringify({
              task_id: deleteRequest.record_id,
              delete_request_id: deleteRequest.id,
            }),
          ]
        );
      } else if (deleteRequest.record_type === "placement") {
        await this.placementModel.initTable();
        // Update placement status to "Archived" and set archived_at timestamp
        await client.query(
          `
          UPDATE placements
          SET status = 'Archived',
              archived_at = CURRENT_TIMESTAMP,
              archive_reason = 'Deletion',
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `,
          [deleteRequest.record_id]
        );

        // Add note within the same transaction to avoid deadlock
        await client.query(
          `
          INSERT INTO placement_notes (placement_id, text, action, about_references, created_by)
          VALUES ($1, $2, $3, $4, $5)
        `,
          [
            deleteRequest.record_id,
            "Record archived following payroll approval",
            null, // action
            null, // about_references
            deleteRequest.reviewed_by
          ]
        );

        await client.query(
          `
          INSERT INTO scheduled_tasks (
            task_type,
            task_data,
            scheduled_for,
            status
          ) VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP + INTERVAL '7 days', 'pending')
        `,
          [
            "archive_cleanup",
            JSON.stringify({
              placement_id: deleteRequest.record_id,
              delete_request_id: deleteRequest.id,
            }),
          ]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Default status per record type when unarchiving (clear archived_at, archive_reason).
   */
  getDefaultStatusForUnarchive(recordType) {
    const map = {
      organization: "Active",
      hiring_manager: "Active",
      job_seeker: "New lead",
      job: "Open",
      lead: "New Lead",
      task: "Pending",
      placement: "Pending",
    };
    return map[recordType] || "Active";
  }

  /**
   * Set record status to pending_archive_approval when archive request is created.
   */
  async setRecordPendingArchive(recordType, recordId) {
    const client = await this.organizationModel.pool.connect();
    const id = typeof recordId === "string" ? parseInt(recordId, 10) : recordId;
    try {
      const tableMap = {
        organization: "organizations",
        hiring_manager: "hiring_managers",
        job_seeker: "job_seekers",
        job: "jobs",
        lead: "leads",
        task: "tasks",
        placement: "placements",
      };
      const table = tableMap[recordType];
      if (!table) return;
      await client.query(
        `UPDATE ${table} SET status = 'pending_archive_approval', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [id]
      );
    } finally {
      client.release();
    }
  }

  /**
   * Restore record status to active when archive request is denied.
   */
  async restoreRecordStatusAfterDeny(recordType, recordId) {
    const defaultStatus = this.getDefaultStatusForUnarchive(recordType);
    const client = await this.organizationModel.pool.connect();
    const id = typeof recordId === "string" ? parseInt(recordId, 10) : recordId;
    try {
      const tableMap = {
        organization: "organizations",
        hiring_manager: "hiring_managers",
        job_seeker: "job_seekers",
        job: "jobs",
        lead: "leads",
        task: "tasks",
        placement: "placements",
      };
      const table = tableMap[recordType];
      if (!table) return;
      await client.query(
        `UPDATE ${table} SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [defaultStatus, id]
      );
    } finally {
      client.release();
    }
  }

  /**
   * Execute unarchive: set archived_at = null, archive_reason = null, status = default.
   */
  async executeUnarchive(unarchiveRequest) {
    const recordId = unarchiveRequest.record_id;
    const recordType = unarchiveRequest.record_type;
    const defaultStatus = this.getDefaultStatusForUnarchive(recordType);
    const client = await this.organizationModel.pool.connect();

    try {
      await client.query("BEGIN");

      if (recordType === "organization") {
        await this.organizationModel.initTable();
        await client.query(
          `
          UPDATE organizations
          SET archived_at = NULL, archive_reason = NULL, status = $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2
        `,
          [defaultStatus, recordId]
        );
        await this.organizationModel.addNote(
          recordId,
          "Record unarchived and restored to active following approval.",
          unarchiveRequest.reviewed_by
        );
      } else if (recordType === "hiring_manager") {
        await this.hiringManagerModel.initTable();
        await client.query(
          `
          UPDATE hiring_managers
          SET archived_at = NULL, archive_reason = NULL, status = $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2
        `,
          [defaultStatus, recordId]
        );
        await this.hiringManagerModel.addNote(
          recordId,
          "Record unarchived and restored to active following approval.",
          unarchiveRequest.reviewed_by
        );
      } else if (recordType === "job_seeker") {
        await this.jobSeekerModel.initTable();
        await client.query(
          `
          UPDATE job_seekers
          SET archived_at = NULL, archive_reason = NULL, status = $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2
        `,
          [defaultStatus, recordId]
        );
        await client.query(
          `
          INSERT INTO job_seeker_notes (job_seeker_id, text, note_type, created_by)
          VALUES ($1, $2, $3, $4)
        `,
          [
            recordId,
            "Record unarchived and restored to active following approval.",
            "General Note",
            unarchiveRequest.reviewed_by,
          ]
        );
      } else if (recordType === "job") {
        await this.jobModel.initTable();
        await client.query(
          `
          UPDATE jobs
          SET archived_at = NULL, archive_reason = NULL, status = $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2
        `,
          [defaultStatus, recordId]
        );
        await client.query(
          `INSERT INTO job_notes (job_id, text, created_by) VALUES ($1, $2, $3)`,
          [
            recordId,
            "Record unarchived and restored to active following approval.",
            unarchiveRequest.reviewed_by,
          ]
        );
      } else if (recordType === "lead") {
        await this.leadModel.initTable();
        await client.query(
          `
          UPDATE leads
          SET archived_at = NULL, archive_reason = NULL, status = $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2
        `,
          [defaultStatus, recordId]
        );
        await client.query(
          `INSERT INTO lead_notes (lead_id, text, created_by) VALUES ($1, $2, $3)`,
          [
            recordId,
            "Record unarchived and restored to active following approval.",
            unarchiveRequest.reviewed_by,
          ]
        );
      } else if (recordType === "task") {
        await this.taskModel.initTable();
        await client.query(
          `
          UPDATE tasks
          SET archived_at = NULL, archive_reason = NULL, status = $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2
        `,
          [defaultStatus, recordId]
        );
        await client.query(
          `INSERT INTO task_notes (task_id, text, created_by) VALUES ($1, $2, $3)`,
          [
            recordId,
            "Record unarchived and restored to active following approval.",
            unarchiveRequest.reviewed_by,
          ]
        );
      } else if (recordType === "placement") {
        await this.placementModel.initTable();
        await client.query(
          `
          UPDATE placements
          SET archived_at = NULL, archive_reason = NULL, status = $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2
        `,
          [defaultStatus, recordId]
        );
        await client.query(
          `INSERT INTO placement_notes (placement_id, text, action, about_references, created_by) VALUES ($1, $2, $3, $4, $5)`,
          [
            recordId,
            "Record unarchived and restored to active following approval.",
            null,
            null,
            unarchiveRequest.reviewed_by,
          ]
        );
      } else {
        await client.query("ROLLBACK");
        throw new Error(`Unknown record_type for unarchive: ${recordType}`);
      }

      await client.query("COMMIT");
    } catch (err) {
      if (client) {
        try {
          await client.query("ROLLBACK");
        } catch (_) {}
      }
      throw err;
    } finally {
      if (client && typeof client.release === "function") {
        client.release();
      }
    }
  }

  async getUnarchiveRequestById(req, res) {
    try {
      const { id } = req.params;
      const request = await this.unarchiveRequestModel.getById(id);
      if (!request) {
        return res.status(404).json({
          success: false,
          message: "Unarchive request not found",
        });
      }
      return res.json({ success: true, deleteRequest: request });
    } catch (error) {
      console.error("Error fetching unarchive request:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch unarchive request",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async approveUnarchive(req, res) {
    try {
      const userId = req.user?.id;
      const { id } = req.params;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      const unarchiveRequest = await this.unarchiveRequestModel.getById(id);
      if (!unarchiveRequest) {
        return res.status(404).json({
          success: false,
          message: "Unarchive request not found",
        });
      }

      if (unarchiveRequest.status !== "pending") {
        return res.status(400).json({
          success: false,
          message: `Unarchive request has already been ${unarchiveRequest.status}.`,
        });
      }

      const requestWithReviewer = { ...unarchiveRequest, reviewed_by: userId };
      await this.executeUnarchive(requestWithReviewer);

      const approved = await this.unarchiveRequestModel.approve(id, userId);

      return res.json({
        success: true,
        message: "Unarchive request approved; record has been restored to active.",
        deleteRequest: approved,
      });
    } catch (error) {
      console.error("Error approving unarchive request:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to approve unarchive request",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async denyUnarchive(req, res) {
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
      if (!denial_reason || !String(denial_reason).trim()) {
        return res.status(400).json({
          success: false,
          message: "Denial reason is required",
        });
      }

      const unarchiveRequest = await this.unarchiveRequestModel.getById(id);
      if (!unarchiveRequest) {
        return res.status(404).json({
          success: false,
          message: "Unarchive request not found",
        });
      }
      if (unarchiveRequest.status !== "pending") {
        return res.status(400).json({
          success: false,
          message: `Unarchive request has already been ${unarchiveRequest.status}.`,
        });
      }

      const denied = await this.unarchiveRequestModel.deny(
        id,
        String(denial_reason).trim(),
        userId
      );

      return res.json({
        success: true,
        message: "Unarchive request denied",
        deleteRequest: denied,
      });
    } catch (error) {
      console.error("Error denying unarchive request:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to deny unarchive request",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  /**
   * Send unarchive request: create DB record, then email with Approve/Deny links to /dashboard/unarchive/[id]/approve and /deny.
   */
  async sendUnarchiveRequest(req, res) {
    try {
      const { id } = req.params;
      let recordType = req.recordType || req.body.record_type;
      if (!recordType && req.baseUrl) {
        if (req.baseUrl.includes("job-seekers")) recordType = "job_seeker";
        else if (req.baseUrl.includes("hiring-managers")) recordType = "hiring_manager";
        else if (req.baseUrl.includes("organizations")) recordType = "organization";
        else if (req.baseUrl.includes("jobs")) recordType = "job";
        else if (req.baseUrl.includes("leads")) recordType = "lead";
        else if (req.baseUrl.includes("tasks")) recordType = "task";
        else if (req.baseUrl.includes("placements")) recordType = "placement";
      }
      recordType = recordType || "organization";
      const { reason, record_number } = req.body;

      if (!reason || !String(reason).trim()) {
        return res.status(400).json({
          success: false,
          message: "Reason is required",
        });
      }

      const userId = req.user?.id || req.user?.userId;
      let user = { name: "Unknown", email: "" };
      if (userId && this.pool) {
        const client = await this.pool.connect();
        try {
          const userQuery = await client.query(
            "SELECT name, email FROM users WHERE id = $1",
            [userId]
          );
          user = userQuery.rows[0] || user;
        } finally {
          client.release();
        }
      }

      const requestedBy = req.body.requested_by || user.name;
      const requestedByEmail = req.body.requested_by_email || user.email;
      const recordDisplay = String(record_number || id);

      const unarchiveRow = await this.unarchiveRequestModel.create({
        record_id: parseInt(id, 10),
        record_type: recordType,
        record_number: recordDisplay,
        requested_by: userId || null,
        requested_by_name: requestedBy,
        requested_by_email: requestedByEmail,
        reason: String(reason).trim(),
      });
      const requestId = unarchiveRow.id;

      const approvalUrl = `${BASE_URL}/dashboard/unarchive/${requestId}/approve`;
      const denyUrl = `${BASE_URL}/dashboard/unarchive/${requestId}/deny`;

      const templateTypeMap = {
        organization: "ORGANIZATION_UNARCHIVE_REQUEST",
        hiring_manager: "HIRING_MANAGER_UNARCHIVE_REQUEST",
        job_seeker: "JOB_SEEKER_UNARCHIVE_REQUEST",
        job: "JOB_UNARCHIVE_REQUEST",
        lead: "LEAD_UNARCHIVE_REQUEST",
        task: "TASK_UNARCHIVE_REQUEST",
        placement: "PLACEMENT_UNARCHIVE_REQUEST",
      };
      const templateType = templateTypeMap[recordType] || "ORGANIZATION_UNARCHIVE_REQUEST";

      const toEmail =
        recordType === "job_seeker"
          ? "onboarding@completestaffingsolutions.com"
          : process.env.PAYROLL_EMAIL || "Payroll@completestaffingsolutions.com";

      const baseUrl = process.env.FRONTEND_URL || BASE_URL;
      let organizationNameLink = recordDisplay;
      const buildOrgLink = (orgId, orgName, fallback) => {
        if (!orgId) return fallback || recordDisplay;
        const name = orgName || fallback || recordDisplay;
        const recordUrl = `${baseUrl}/dashboard/organizations/view?id=${orgId}`;
        return `<a href="${recordUrl}" style="color:#2563eb;text-decoration:underline;">${name}</a>`;
      };
      try {
        const recordId = parseInt(id, 10);
        if (recordType === "organization") {
          const org = await this.organizationModel.getById(recordId);
          organizationNameLink = buildOrgLink(recordId, org?.name, recordDisplay);
        } else if (recordType === "hiring_manager") {
          const hm = await this.hiringManagerModel.getById(recordId);
          const orgId = hm?.organization_id;
          if (orgId) {
            const org = await this.organizationModel.getById(orgId);
            organizationNameLink = buildOrgLink(orgId, org?.name, recordDisplay);
          }
        } else if (recordType === "job") {
          const job = await this.jobModel.getById(recordId);
          const orgId = job?.organization_id;
          if (orgId) {
            const org = await this.organizationModel.getById(orgId);
            organizationNameLink = buildOrgLink(orgId, org?.name, recordDisplay);
          }
        } else if (recordType === "lead") {
          const lead = await this.leadModel.getById(recordId);
          const orgId = lead?.organization_id;
          if (orgId) {
            const org = await this.organizationModel.getById(orgId);
            organizationNameLink = buildOrgLink(orgId, org?.name, recordDisplay);
          }
        } else if (recordType === "task") {
          const task = await this.taskModel.getById(recordId);
          const orgId = task?.organization_id;
          if (orgId) {
            const org = await this.organizationModel.getById(orgId);
            organizationNameLink = buildOrgLink(orgId, org?.name, recordDisplay);
          }
        } else if (recordType === "placement") {
          const placement = await this.placementModel.findById(recordId);
          const orgId = placement?.organizationId ?? placement?.organization_id;
          if (orgId) {
            const org = await this.organizationModel.getById(orgId);
            organizationNameLink = buildOrgLink(orgId, org?.name, recordDisplay);
          }
        } else if (recordType === "job_seeker") {
          const placements = await this.placementModel.findByJobSeekerId(recordId);
          const first = placements?.[0];
          const orgId = first?.organizationId ?? first?.organization_id;
          if (orgId) {
            const org = await this.organizationModel.getById(orgId);
            organizationNameLink = buildOrgLink(orgId, org?.name, recordDisplay);
          }
        }
      } catch (err) {
        console.error("Error fetching organization for unarchive email:", err);
      }

      const vars = {
        requestedBy,
        requestedByEmail,
        recordType,
        recordNumber: recordDisplay,
        organizationNameLink,
        reason: String(reason).trim(),
        requestDate,
        approvalUrl,
        denyUrl,
      };

      const tpl = await this.emailTemplateModel.getTemplateByType(templateType);
      const unarchiveSafeKeys = ["approvalUrl", "denyUrl", "organizationNameLink"];
      if (tpl) {
        const subject = renderTemplate(tpl.subject, vars, unarchiveSafeKeys);
        let html = renderTemplate(tpl.body, vars, unarchiveSafeKeys);
        html = html.replace(/\r\n/g, "\n").replace(/\n/g, "<br/>");
        await sendMail({ to: toEmail, subject, html });
      } else {
        const subject = `Unarchive Request: ${recordType} ${recordDisplay}`;
        const html = `
          <h2>Unarchive Request</h2>
          <p>An unarchive request has been submitted.</p>
          <p><strong>Record (${recordType}):</strong> ${recordDisplay}</p>
          <p><strong>Requested By:</strong> ${vars.requestedBy} (${vars.requestedByEmail})</p>
          <p><strong>Request Date:</strong> ${requestDate}</p>
          <p><strong>Reason:</strong> ${vars.reason}</p>
          <p><a href="${approvalUrl}">Approve Unarchive</a> | <a href="${denyUrl}">Deny Unarchive</a></p>
        `.replace(/\n/g, "<br/>");
        await sendMail({ to: toEmail, subject, html });
      }

      return res.status(200).json({
        success: true,
        message: "Unarchive request sent successfully",
      });
    } catch (error) {
      console.error("Error sending unarchive request:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to send unarchive request",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }
}

module.exports = DeleteRequestController;
