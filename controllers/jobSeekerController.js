const JobSeeker = require("../models/jobseeker");
const Document = require("../models/document");
const JobSeekerApplication = require("../models/jobSeekerApplication");
const Job = require("../models/job");
const User = require("../models/user");
const EmailTemplateModel = require("../models/emailTemplateModel");
const ActivityLog = require("../models/activityLog");
const { put } = require("@vercel/blob");
const {
  normalizeCustomFields,
  normalizeListCustomFields,
} = require("../utils/exportHelpers");
const { sendMail } = require("../services/emailService");
const { renderTemplate, escapeHtml } = require("../utils/templateRenderer");
const { resolveRecordOwnerUserId } = require("../utils/ownerHelpers");

const jwt = require("jsonwebtoken");

const bcrypt = require("bcrypt");

const DEBUG_TAG = "[Applications addApplication]";

class JobSeekerController {
  constructor(pool) {
    this.pool = pool;

    this.jobSeekerModel = new JobSeeker(pool);

    this.documentModel = new Document(pool);

    this.applicationModel = new JobSeekerApplication(pool);

    this.jobModel = new Job(pool);

    this.userModel = new User(pool);

    this.emailTemplateModel = new EmailTemplateModel(pool);

    this.activityLogModel = new ActivityLog(pool);

    this.create = this.create.bind(this);

    this.getAll = this.getAll.bind(this);

    this.getById = this.getById.bind(this);

    this.update = this.update.bind(this);

    this.bulkUpdate = this.bulkUpdate.bind(this);

    this.delete = this.delete.bind(this);

    this.addNote = this.addNote.bind(this);

    this.getNotes = this.getNotes.bind(this);

    this.getHistory = this.getHistory.bind(this);

    this.getReferences = this.getReferences.bind(this);

    this.addReference = this.addReference.bind(this);

    this.deleteReference = this.deleteReference.bind(this);

    this.getApplications = this.getApplications.bind(this);

    this.addApplication = this.addApplication.bind(this);

    this.updateApplication = this.updateApplication.bind(this);
    this.getCandidateFlowStats = this.getCandidateFlowStats.bind(this);
    this.getApplicationsBoard = this.getApplicationsBoard.bind(this);

    this.getDocuments = this.getDocuments.bind(this);

    this.getDocument = this.getDocument.bind(this);

    this.addDocument = this.addDocument.bind(this);

    this.uploadDocument = this.uploadDocument.bind(this);

    this.updateDocument = this.updateDocument.bind(this);

    this.deleteDocument = this.deleteDocument.bind(this);

    this.checkDuplicates = this.checkDuplicates.bind(this);
  }

  // GET /job-seekers/applications/board - applications grouped by status for Kanban
  async getApplicationsBoard(req, res) {
    try {
      const userId = req.user?.id;
      const isAdmin =
        req.user?.role === "admin" ||
        req.user?.role === "owner" ||
        req.user?.userType === "admin" ||
        req.user?.userType === "owner";
      const scopeUserId = isAdmin ? null : userId;
      const rows = await this.applicationModel.getAllForBoard(scopeUserId);
      const statusToColumn = {
        Submission: "submission",
        "Client Submitted": "client-submitted",
        Interview: "interview",
        "Offer Extended": "offer-extended",
        Placement: "placement", // legacy data
        Placed: "placement",
      };
      const board = {
        submission: [],
        "client-submitted": [],
        interview: [],
        "offer-extended": [],
        placement: [],
      };
      for (const row of rows) {
        const status = (row.status || "").trim() || "Submission";
        const col = statusToColumn[status] || "submission";
        if (!board[col]) board[col] = [];
        board[col].push({
          id: row.id,
          jobSeekerId: row.job_seeker_id,
          jobId: row.job_id,
          jobTitle: row.job_title || "",
          companyName: row.organization_name || "",
          clientName: row.client_name || "",
          status: row.status,
          createdAt: row.created_at,
          candidateId: row.job_seeker_id,
        });
      }
      return res.status(200).json({ success: true, board });
    } catch (error) {
      console.error("Error fetching applications board:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to load applications board",
        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  // GET /job-seekers/candidate-flow - prescreen counts and list for candidate flow dashboard
  async getCandidateFlowStats(req, res) {
    try {
      const userId = req.user?.id;
      const [prescreenedTotal, prescreenedByUserLast30Days] = await Promise.all(
        [
          this.jobSeekerModel.getPrescreenedCount(),
          userId
            ? this.jobSeekerModel.getPrescreenedByUserInLast30Days(userId)
            : [],
        ],
      );
      res.status(200).json({
        success: true,
        prescreenedTotal,
        prescreenedByUserLast30Days,
      });
    } catch (error) {
      console.error("Error getting candidate flow stats:", error);
      res.status(500).json({
        success: false,
        message: "An error occurred while retrieving candidate flow stats",
        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async getApplications(req, res) {
    try {
      const { id } = req.params;
      const scope = (req.query?.scope || "").toString();
      const scopeUserId =
        scope === "current-user" && req.user?.id ? req.user.id : null;

      const jobSeeker = await this.jobSeekerModel.getById(id, null);

      if (!jobSeeker) {
        return res.status(404).json({
          success: false,
          message: "Job seeker not found",
        });
      }

      const applications = await this.applicationModel.getByJobSeekerId(
        id,
        scopeUserId,
      );

      return res.status(200).json({
        success: true,
        count: applications.length,
        applications,
      });
    } catch (error) {
      console.error("Error getting job seeker applications:", error);
      return res.status(500).json({
        success: false,
        message: "An error occurred while retrieving applications",
        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  // GET /job-seekers/check-duplicates?email=&phone=&excludeId=
  async checkDuplicates(req, res) {
    try {
      const { email = "", phone = "", excludeId = "" } = req.query || {};

      const normEmail = (email || "").toString().trim().toLowerCase();
      const normPhone = (phone || "").toString().replace(/\D/g, "").trim();

      if (!normEmail && !normPhone) {
        return res.status(200).json({
          success: true,
          duplicates: { email: [], phone: [] },
        });
      }

      const client = await this.pool.connect();
      try {
        const params = [];
        const conditions = [];

        if (normEmail) {
          params.push(normEmail);
          conditions.push("LOWER(email) = $" + params.length);
        }
        if (normPhone) {
          params.push(normPhone);
          conditions.push(
            "REGEXP_REPLACE(phone, '\\\\D', '', 'g') = $" + params.length,
          );
        }
        if (excludeId) {
          params.push(excludeId);
          conditions.push("id <> $" + params.length);
        }

        const whereClause = conditions.length
          ? "WHERE " + conditions.join(" AND ")
          : "";

        const query = `
          SELECT id, first_name, last_name, email, phone
          FROM job_seekers
          ${whereClause}
        `;

        const result = await client.query(query, params);
        const rows = result.rows || [];

        const dupEmail = [];
        const dupPhone = [];

        for (const row of rows) {
          const fullName =
            `${row.first_name || ""} ${row.last_name || ""}`.trim() ||
            "Unnamed";
          if (
            normEmail &&
            row.email &&
            row.email.toLowerCase().trim() === normEmail
          ) {
            dupEmail.push({ id: row.id, name: fullName });
          }
          if (normPhone) {
            const jsPhone = (row.phone || "")
              .toString()
              .replace(/\D/g, "")
              .trim();
            if (jsPhone && jsPhone === normPhone) {
              dupPhone.push({ id: row.id, name: fullName });
            }
          }
        }

        return res.status(200).json({
          success: true,
          duplicates: {
            email: dupEmail,
            phone: dupPhone,
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Error checking job seeker duplicates:", error);
      return res.status(500).json({
        success: false,
        message: "An error occurred while checking duplicates",
        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async addApplication(req, res) {
    try {
      const { id } = req.params;

      const userId = req.user.id;

      const application = req.body || {};

      const allowedTypes = [
        "web_submissions",
        "submissions",
        "client_submissions",
      ];

      if (!application.type || !allowedTypes.includes(application.type)) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid application type. Allowed: web_submissions, submissions, client_submissions",
        });
      }

      const jobSeeker = await this.jobSeekerModel.getById(id, null);

      if (!jobSeeker) {
        return res.status(404).json({
          success: false,
          message: "Job seeker not found",
        });
      }

      // Resolve job + organization so organization comes from the Job's organization_id
      // (or its denormalized organization_name), rather than relying on the request payload.
      let resolvedJobTitle = application.job_title || "";
      let resolvedOrganizationId =
        application.organization_id !== undefined
          ? application.organization_id
          : null;
      let resolvedOrganizationName = application.organization_name || "";

      if (application.job_id) {
        try {
          const pool = this.jobSeekerModel.pool;
          const client = await pool.connect();
          try {
            const jobResult = await client.query(
              `
              SELECT
                j.job_title,
                j.organization_id,
                o.name AS organization_name
              FROM jobs j
              LEFT JOIN organizations o ON j.organization_id = o.id
              WHERE j.id = $1
              `,
              [application.job_id],
            );
            const jobRow = jobResult.rows[0];
            if (jobRow) {
              if (!resolvedJobTitle) {
                resolvedJobTitle = jobRow.job_title || "";
              }
              if (
                (resolvedOrganizationId === null ||
                  resolvedOrganizationId === undefined ||
                  resolvedOrganizationId === "") &&
                jobRow.organization_id
              ) {
                resolvedOrganizationId = jobRow.organization_id;
              }
              if (!resolvedOrganizationName) {
                resolvedOrganizationName = jobRow.organization_name || "";
              }
            }
          } finally {
            // Ensure client is always released
            // even if the query above throws.
            await client.release();
          }
        } catch (err) {
          console.error(
            `${DEBUG_TAG} Error resolving job organization for application:`,
            err && err.message ? err.message : err,
          );
        }
      }

      if (application.job_id) {
        try {
          const exists = await this.applicationModel.existsForJobSeekerAndJob(
            parseInt(id, 10),
            application.job_id
          );
          if (exists) {
            return res.status(400).json({
              success: false,
              message:
                "This job seeker has already been submitted to this job. Duplicate submissions are not allowed.",
            });
          }
        } catch (dupErr) {
          console.error(
            "[Applications addApplication] duplicate check failed:",
            dupErr && dupErr.message ? dupErr.message : dupErr
          );
        }
      }

      const newApplication = await this.applicationModel.create({
        job_seeker_id: parseInt(id, 10),
        type: application.type,
        job_id: application.job_id || null,
        job_title: resolvedJobTitle,
        organization_id: resolvedOrganizationId,
        organization_name: resolvedOrganizationName,
        client_id: application.client_id || null,
        client_name: application.client_name || "",
        created_by: application.created_by || userId,
        notes: application.notes || "",
        status: application.status || "",
        submission_source:
          application.submission_source || application.submissionSource || "",
      });

      if (newApplication.job_id) {
        const statusForNote =
          (newApplication.status && String(newApplication.status).trim()) ||
          "Submission";
        await this._createStatusChangeNotesAndNotify(
          parseInt(id, 10),
          newApplication.job_id,
          statusForNote,
          userId,
          jobSeeker,
          null
        );
      }

      const submittedByName =
        application.submitted_by_name || application.submittedBy || "Recruiter";
      const candidateName =
        `${jobSeeker.first_name || ""} ${jobSeeker.last_name || ""}`.trim() ||
        jobSeeker.full_name ||
        "Candidate";

      const toEmails = [];
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      const submittedByEmail =
        application.submitted_by_email || application.submittedByEmail || "";
      if (
        submittedByEmail &&
        emailRegex.test(String(submittedByEmail).trim())
      ) {
        toEmails.push(String(submittedByEmail).trim());
      }

      let jobTitleFromDb =
        newApplication.job_title || application.job_title || null;

      try {
        const pool = this.jobSeekerModel.pool;
        const client = await pool.connect();
        try {
          if (jobSeeker.owner) {
            const ownerId =
              typeof jobSeeker.owner === "number"
                ? jobSeeker.owner
                : parseInt(jobSeeker.owner, 10);
            if (!Number.isNaN(ownerId)) {
              const ownerRow = await client.query(
                "SELECT email FROM users WHERE id = $1",
                [ownerId],
              );
              const ownerEmail = ownerRow.rows[0]?.email;
              if (
                ownerEmail &&
                emailRegex.test(String(ownerEmail).trim()) &&
                !toEmails.includes(String(ownerEmail).trim())
              ) {
                toEmails.push(String(ownerEmail).trim());
              }
            }
          }

          if (application.job_id) {
            const jobRow = await client.query(
              "SELECT owner, job_title FROM jobs WHERE id = $1",
              [application.job_id],
            );
            const job = jobRow.rows[0];
            if (job?.job_title) {
              jobTitleFromDb = job.job_title;
              newApplication.job_title = job.job_title;
            }
            if (job?.owner) {
              const jobOwnerId =
                typeof job.owner === "number"
                  ? job.owner
                  : parseInt(job.owner, 10);
              if (!Number.isNaN(jobOwnerId)) {
                const jobOwnerRow = await client.query(
                  "SELECT email FROM users WHERE id = $1",
                  [jobOwnerId],
                );
                const jobOwnerEmail = jobOwnerRow.rows[0]?.email;
                if (
                  jobOwnerEmail &&
                  emailRegex.test(String(jobOwnerEmail).trim()) &&
                  !toEmails.includes(String(jobOwnerEmail).trim())
                ) {
                  toEmails.push(String(jobOwnerEmail).trim());
                }
              }
            }
          }
        } finally {
          client.release();
        }

        const jobTitleDisplay = jobTitleFromDb
          ? application.job_id
            ? `${jobTitleFromDb} (Job #${application.job_id})`
            : jobTitleFromDb
          : application.job_id
            ? `Job #${application.job_id}`
            : "Job";

        const submissionTypeLabel =
          newApplication.type === "client_submissions"
            ? "Client Submission"
            : newApplication.type === "web_submissions"
              ? "Web Submission"
              : newApplication.type === "submissions"
                ? "Submission"
                : newApplication.type || "—";
        const submissionSource =
          application.submission_source || application.submissionSource || "—";
        const submittedAt = new Date(newApplication.created_at).toLocaleString(
          "en-GB",
          { dateStyle: "medium", timeStyle: "short" },
        );
        const frontendBase =
          process.env.FRONTEND_URL ||
          process.env.NEXT_PUBLIC_BASE_URL ||
          "https://your-ats.com";
        const viewCandidateUrl = `${frontendBase.replace(/\/$/, "")}/dashboard/job-seekers/view?id=${id}`;

        const submissionSummary =
          (newApplication.notes && String(newApplication.notes).trim()) ||
          "No additional notes provided.";

        const uniqueEmails = [...new Set(toEmails)];

        if (uniqueEmails.length > 0) {
          const tpl = await this.emailTemplateModel.getTemplateByType(
            "JOB_SEEKER_APPLICATION_SUBMISSION",
          );
          const candidateNameLink = `<a href="${viewCandidateUrl}" style="color:#2563eb;text-decoration:underline;">${escapeHtml(candidateName)}</a>`;
          const vars = {
            candidateName,
            candidateNameLink,
            jobTitle: jobTitleDisplay,
            submittedBy: submittedByName,
            submissionType: submissionTypeLabel,
            source: submissionSource,
            submittedAt,
            submissionSummary,
            viewCandidateUrl,
          };
          const safeKeys = ["candidateNameLink"];

          if (tpl) {
            const subject = renderTemplate(tpl.subject, vars, safeKeys);
            const html = renderTemplate(tpl.body, vars, safeKeys)
              .replace(/\r\n/g, "\n")
              .replace(/\n/g, "<br/>");
            await sendMail({
              to: uniqueEmails,
              subject,
              html,
            });
          } else {
            const emailBody = `
Candidate: ${candidateName}
Job: ${jobTitleDisplay}

Submitted By: ${submittedByName}
Submission Type: ${submissionTypeLabel}
Source: ${submissionSource}
Submitted At: ${submittedAt}

Submission Summary:
------------------------------------
${submissionSummary}
------------------------------------

View Candidate:
${viewCandidateUrl}

This is an automated notification from the ATS.
`.trim();
            await sendMail({
              to: uniqueEmails,
              subject: `New Candidate Submission: ${candidateName} → ${jobTitleFromDb || (application.job_id ? `Job #${application.job_id}` : "Job")}`,
              text: emailBody,
            });
          }
          console.log(DEBUG_TAG, "notification email sent", {
            to: uniqueEmails,
            subjectCandidate: candidateName,
            jobTitleDisplay,
            submittedByName,
          });
        } else {
          console.warn(
            DEBUG_TAG,
            "no recipient emails; skipping notification",
            {
              submitted_by_email:
                application.submitted_by_email || application.submittedByEmail,
              jobSeekerOwner: jobSeeker.owner,
              job_id: application.job_id,
            },
          );
        }

        try {
          const noteText = `Candidate ${candidateName} submitted to ${jobTitleDisplay} by ${submittedByName}.`;
          await this.jobSeekerModel.addNoteAndUpdateContact(
            id,
            noteText,
            userId,
            "Client Submission",
            "Client Submission",
            null,
          );
          console.log(DEBUG_TAG, "system note added");
        } catch (noteErr) {
          console.error(DEBUG_TAG, "system note failed", noteErr);
        }
      } catch (emailErr) {
        console.error(DEBUG_TAG, "notification email failed", emailErr);
      }

      const applications = await this.applicationModel.getByJobSeekerId(id);
      return res.status(201).json({
        success: true,
        application: newApplication,
        applications,
      });
    } catch (error) {
      console.error("Error adding job seeker application:", error);
      return res.status(500).json({
        success: false,
        message: "An error occurred while adding the application",
        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  /**
   * Create auto-generated notes on job seeker and job when application status changes,
   * and send email to job seeker record owner and job record owner.
   * Non-blocking: errors are logged and do not fail the request.
   */
  async _createStatusChangeNotesAndNotify(
    jobSeekerId,
    jobId,
    newStatus,
    performedByUserId,
    jobSeeker,
    job
  ) {
    if (!jobId || !newStatus) return;
    try {
      const jobRecord = job || (await this.jobModel.getById(jobId, null));
      if (!jobRecord) return;

      const first = (jobSeeker && (jobSeeker.first_name || "").trim()) || "";
      const last = (jobSeeker && (jobSeeker.last_name || "").trim()) || "";
      const combined = (first + " " + last).trim();
      const jobSeekerName =
        combined || (jobSeeker && jobSeeker.full_name) || ("Job Seeker #" + jobSeekerId);
      const jobDisplay =
        jobRecord.record_number != null
          ? `Job #${jobRecord.record_number}`
          : `Job #${jobRecord.id}`;
      const jobTitleDisplay = jobRecord.job_title
        ? `${jobDisplay} ${jobRecord.job_title}`
        : jobDisplay;

      const noteTextOnJobSeeker = `Application status set to ${newStatus} for ${jobTitleDisplay}.`;
      const noteTextOnJob = `Job seeker ${jobSeekerName} application status set to ${newStatus}.`;

      const aboutRefJob = [
        {
          id: String(jobRecord.id),
          type: "Job",
          display: jobTitleDisplay,
          value: jobDisplay,
        },
      ];
      const aboutRefJobSeeker = [
        {
          id: String(jobSeekerId),
          type: "Job Seeker",
          display: `${jobSeekerName}`,
          value: jobSeekerName,
        },
      ];

      const userId = performedByUserId || jobSeeker?.created_by || jobRecord.created_by;

      await this.jobSeekerModel.addNoteAndUpdateContact(
        jobSeekerId,
        noteTextOnJobSeeker,
        userId,
        "General Note",
        newStatus,
        aboutRefJob
      );

      await this.jobModel.addNote(
        jobId,
        noteTextOnJob,
        userId,
        newStatus,
        aboutRefJobSeeker
      );

      // Resolve owners: job seeker record owner and job record owner (for email)
      const jsOwnerId = resolveRecordOwnerUserId(jobSeeker);
      const jobOwnerId = resolveRecordOwnerUserId(jobRecord);
      const ownerIds = [jsOwnerId, jobOwnerId].filter(
        (id) => id != null && id !== ""
      );
      const uniqueOwnerIds = [...new Set(ownerIds)];
      if (uniqueOwnerIds.length === 0) return;

      const users = await this.userModel.getUsersByIds(uniqueOwnerIds);
      const emails = users
        .map((u) => u.email)
        .filter((e) => e && String(e).trim());
      if (emails.length === 0) return;

      const baseUrl =
        process.env.FRONTEND_URL ||
        process.env.NEXT_PUBLIC_BASE_URL ||
        "https://your-ats.com";
      const candidateUrl = `${baseUrl.replace(/\/$/, "")}/dashboard/job-seekers/view?id=${jobSeekerId}`;
      const jobUrl = `${baseUrl.replace(/\/$/, "")}/dashboard/jobs/view?id=${jobId}`;

      const subject = `Application status update: ${jobSeekerName} → ${newStatus}`;
      const html = `
        <p>Application status has been updated.</p>
        <ul>
          <li><strong>Job seeker:</strong> <a href="${candidateUrl}">${escapeHtml(jobSeekerName)}</a></li>
          <li><strong>Job:</strong> <a href="${jobUrl}">${escapeHtml(jobTitleDisplay)}</a></li>
          <li><strong>New status:</strong> ${escapeHtml(newStatus)}</li>
        </ul>
        <p>This is an automated notification from the ATS.</p>
      `;

      await sendMail({
        to: emails,
        subject,
        html,
      });
    } catch (err) {
      console.error(
        "[JobSeekerController] _createStatusChangeNotesAndNotify:",
        err && err.message ? err.message : err
      );
    }
  }

  async updateApplication(req, res) {
    try {
      const { id: jobSeekerId, applicationId } = req.params;
      const body = req.body || {};
      const applicationIdNum = parseInt(applicationId, 10);
      if (Number.isNaN(applicationIdNum)) {
        return res.status(400).json({
          success: false,
          message: "Invalid application ID",
        });
      }
      const jobSeeker = await this.jobSeekerModel.getById(jobSeekerId, null);
      if (!jobSeeker) {
        return res.status(404).json({
          success: false,
          message: "Job seeker not found",
        });
      }

      // Core pipeline statuses (strict order / no skipping)
      const APPLICATION_STATUS_ORDER = [
        "Submission",
        "Client Submitted",
        "Interview",
        "Offer Extended",
        "Placed",
      ];
      // All statuses that backend accepts (including terminal / non‑pipeline)
      const APPLICATION_STATUS_ALLOWED = [
        ...APPLICATION_STATUS_ORDER,
        "Client Rejected",
        "Job Seeker Withdrew",
      ];
      const normalizeStatus = (s) => {
        if (!s || typeof s !== "string") return "";
        const t = s.trim();
        const tl = t.toLowerCase();

        // Case‑insensitive normalization to canonical labels
        if (tl === "submission" || tl === "submitted") return "Submission";
        if (tl === "client submitted" || tl === "client submission")
          return "Client Submitted";
        if (tl === "interview") return "Interview";
        if (tl === "offer extended" || tl === "offer") return "Offer Extended";
        if (tl === "placement" || tl === "placed") return "Placed";
        if (tl === "client rejected") return "Client Rejected";
        if (tl === "job seeker withdrew" || tl === "jobseeker withdrew")
          return "Job Seeker Withdrew";

        // Fallback – return trimmed original if no mapping matched
        return t;
      };

      const updates = {};
      let previousStatus = null;
      if (body.status !== undefined) {
        const newStatus = normalizeStatus(body.status);
        if (!APPLICATION_STATUS_ALLOWED.includes(newStatus)) {
          return res.status(400).json({
            success: false,
            message: `Invalid status. Allowed: ${APPLICATION_STATUS_ALLOWED.join(
              ", ",
            )}`,
          });
        }
        const currentApp = await this.applicationModel.getById(
          applicationIdNum,
          parseInt(jobSeekerId, 10),
        );
        previousStatus = currentApp?.status ?? "";
        if (currentApp) {
          const currentNorm = normalizeStatus(currentApp.status || "");
          const fromIdx = APPLICATION_STATUS_ORDER.indexOf(currentNorm);
          const toIdx = APPLICATION_STATUS_ORDER.indexOf(newStatus);
          const isNewInPipeline = toIdx !== -1;
          const isCurrentInPipeline = fromIdx !== -1;

          if (isCurrentInPipeline && isNewInPipeline) {
            // Strict forward-only pipeline: Submission → Client Submitted → Interview → Offer Extended → Placed
            if (toIdx <= fromIdx) {
              return res.status(400).json({
                success: false,
                message:
                  "Status can only move forward: Submission → Client Submitted → Interview → Offer Extended → Placed",
              });
            }
            if (toIdx !== fromIdx + 1) {
              return res.status(400).json({
                success: false,
                message: "Only the next stage is allowed. No skipping.",
              });
            }
          }
          // If either current or new status is outside the main pipeline
          // (e.g. Client Rejected, Job Seeker Withdrew), we allow the change
          // as long as the value itself is in APPLICATION_STATUS_ALLOWED.
        }
        updates.status = newStatus;
      }
      if (body.notes !== undefined) updates.notes = String(body.notes).trim();

      const updated = await this.applicationModel.update(
        applicationIdNum,
        parseInt(jobSeekerId, 10),
        updates,
      );
      if (!updated) {
        return res.status(404).json({
          success: false,
          message: "Application not found",
        });
      }

      if (updates.status !== undefined) {
        try {
          await this.activityLogModel.logActivity({
            userId: req.user?.id,
            userName: req.user?.name || req.user?.email,
            action: "status_change",
            entityType: "job_seeker_application",
            entityId: String(applicationIdNum),
            entityLabel: `Application #${applicationIdNum}`,
            metadata: { from: previousStatus, to: updated.status },
          });
        } catch (logErr) {
          console.error("Error logging application status change:", logErr);
        }

        if (updated.job_id) {
          await this._createStatusChangeNotesAndNotify(
            parseInt(jobSeekerId, 10),
            updated.job_id,
            updated.status,
            req.user?.id,
            jobSeeker,
            null
          );
        }
      }

      return res.status(200).json({
        success: true,
        application: updated,
      });
    } catch (error) {
      console.error("Error updating job seeker application:", error);
      return res.status(500).json({
        success: false,
        message: "An error occurred while updating the application",
        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  // Initialize database tables

  async initTables() {
    await this.jobSeekerModel.initTable();

    await this.applicationModel.initTable();
  }

  // Create a new job seeker

  async create(req, res) {
    // ✅ Extract fields explicitly like Organizations (including custom_fields)

    const {
      firstName,

      lastName,

      email,

      phone,

      mobilePhone,

      address,

      city,

      state,

      zip,

      status,

      currentOrganization,

      title,

      resumeText,

      skills,

      desiredSalary,

      owner,

      dateAdded,

      lastContactDate,

      custom_fields, // ✅ Extract custom_fields from request
    } = req.body;

    console.log("Create job seeker request body:", req.body);

    console.log("custom_fields in req.body:", req.body.custom_fields);

    console.log("custom_fields type:", typeof req.body.custom_fields);

    console.log(
      "custom_fields keys:",
      req.body.custom_fields
        ? Object.keys(req.body.custom_fields).length
        : "null/undefined",
    );

    // Basic validation

    // if (!jobSeekerData.firstName || !jobSeekerData.lastName) {

    //     return res.status(400).json({

    //         success: false,

    //         message: 'First name and last name are required'

    //     });

    // }

    try {
      // Get the current user's ID from the auth middleware

      const userId = req.user.id;

      // ✅ Build model data with custom_fields (same pattern as Organizations)

      const modelData = {
        firstName,

        lastName,

        email,

        phone,

        mobilePhone,

        address,

        city,

        state,

        zip,

        status,

        currentOrganization,

        title,

        resumeText,

        skills,

        desiredSalary,

        owner,

        dateAdded,

        lastContactDate,

        userId,

        custom_fields: custom_fields || {}, // ✅ Use snake_case to match model expectation
      };

      // Create job seeker in database

      const jobSeeker = await this.jobSeekerModel.create(modelData);

      // Send success response

      res.status(201).json({
        success: true,

        message: "Job seeker created successfully",

        jobSeeker,
      });
    } catch (error) {
      console.error("Detailed error creating job seeker:", error);

      // Check for Postgres unique violation on email (code 23505 on our email index)
      if (
        error &&
        error.code === "23505" &&
        (error.constraint === "idx_job_seekers_email_lower_unique" ||
          (typeof error.detail === "string" &&
            error.detail.toLowerCase().includes("email")))
      ) {
        return res.status(409).json({
          success: false,
          field: "email",
          message: "A job seeker with this email already exists",
        });
      }

      // Log the full error object to see all properties

      console.error(
        "Error object:",

        JSON.stringify(error, Object.getOwnPropertyNames(error)),
      );

      res.status(500).json({
        success: false,

        message: "An error occurred while creating the job seeker",

        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  // Get all job seekers (archived param: 'true' = only archived, 'false' = exclude archived, omit = all - like jobs)

  async getAll(req, res) {
    try {
      const archivedParam = req.query?.archived;
      const archivedFilter =
        archivedParam === "true"
          ? true
          : archivedParam === "false"
            ? false
            : null;
      const jobSeekers = await this.jobSeekerModel.getAll(null, archivedFilter);
      const normalized = normalizeListCustomFields(jobSeekers);

      res.status(200).json({
        success: true,
        count: normalized.length,
        jobSeekers: normalized,
      });
    } catch (error) {
      console.error("Error getting job seekers:", error);

      res.status(500).json({
        success: false,

        message: "An error occurred while retrieving job seekers",

        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  // Get job seeker by ID

  async getById(req, res) {
    try {
      const { id } = req.params;

      // Get the current user's ID from the auth middleware

      const userId = req.user.id;

      const userRole = req.user.role;

      const jobSeeker = await this.jobSeekerModel.getById(id, null);

      if (!jobSeeker) {
        return res.status(404).json({
          success: false,

          message: "Job seeker not found",
        });
      }

      const normalizedJobSeeker = normalizeCustomFields(jobSeeker);
      res.status(200).json({
        success: true,
        jobSeeker: normalizedJobSeeker,
      });
    } catch (error) {
      console.error("Error getting job seeker:", error);

      res.status(500).json({
        success: false,

        message: "An error occurred while retrieving the job seeker",

        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  // Update job seeker by ID

  async update(req, res) {
    try {
      const { id } = req.params;

      const updateData = req.body;

      console.log(`Update request for job seeker ${id} received`);

      console.log("Request user:", req.user);

      console.log("Update data:", JSON.stringify(updateData, null, 2));

      // Get the current user's ID from the auth middleware

      const userId = req.user.id;

      const userRole = req.user.role;

      console.log(`User role: ${userRole}, User ID: ${userId}`);

      const jobSeeker = await this.jobSeekerModel.update(id, updateData, null);

      if (!jobSeeker) {
        console.log("Update failed - job seeker not found or no permission");

        return res.status(404).json({
          success: false,

          message:
            "Job seeker not found or you do not have permission to update it",
        });
      }

      console.log("Job seeker updated successfully:", jobSeeker);

      res.status(200).json({
        success: true,

        message: "Job seeker updated successfully",

        jobSeeker,
      });
    } catch (error) {
      console.error("Error updating job seeker:", error);

      // Check for specific error types

      if (
        error.message &&
        (error.message.includes("permission") ||
          error.message.includes("not found"))
      ) {
        return res.status(403).json({
          success: false,

          message: error.message,
        });
      }

      res.status(500).json({
        success: false,

        message: "An error occurred while updating the job seeker",

        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  // Bulk update job seekers
  async bulkUpdate(req, res) {
    try {
      console.log("=== BULK UPDATE REQUEST START ===");
      console.log("Request body:", JSON.stringify(req.body, null, 2));
      console.log("User ID:", req.user?.id);
      console.log("User:", req.user);

      const { ids, updates } = req.body;

      // Validate input
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        console.error(
          "Validation failed: IDs array is required and must not be empty",
        );
        return res.status(400).json({
          success: false,
          message: "IDs array is required and must not be empty",
        });
      }

      if (!updates || typeof updates !== "object") {
        console.error("Validation failed: Updates object is required");
        return res.status(400).json({
          success: false,
          message: "Updates object is required",
        });
      }

      const userId = req.user.id;
      const userRole = req.user.role;
      console.log(
        "Processing bulk update for user:",
        userId,
        "role:",
        userRole,
      );
      console.log("Job Seeker IDs to update:", ids);
      console.log("Updates to apply:", JSON.stringify(updates, null, 2));

      const results = {
        successful: [],
        failed: [],
        errors: [],
      };

      // Update each job seeker
      for (const id of ids) {
        try {
          console.log(`\n--- Processing job seeker ${id} ---`);
          const updateData = JSON.parse(JSON.stringify(updates));
          console.log(`Calling jobSeekerModel.update(${id}, updates, null)`);

          const jobSeeker = await this.jobSeekerModel.update(
            id,
            updateData,
            null,
          );

          if (jobSeeker) {
            results.successful.push(id);
            console.log(`✅ Successfully updated job seeker ${id}`);
          } else {
            results.failed.push(id);
            results.errors.push({
              id,
              error: "Job seeker not found or permission denied",
            });
            console.error(
              `❌ Failed to update job seeker ${id}: not found or permission denied`,
            );
          }
        } catch (error) {
          results.failed.push(id);
          const errorMsg = error.message || "Unknown error";
          results.errors.push({ id, error: errorMsg });
          console.error(`❌ Error updating job seeker ${id}:`, errorMsg);
        }
      }

      console.log("\n=== BULK UPDATE RESULTS ===");
      console.log(`Successful: ${results.successful.length}/${ids.length}`);
      console.log(`Failed: ${results.failed.length}/${ids.length}`);
      console.log("=== BULK UPDATE REQUEST END ===\n");

      res.status(200).json({
        success: true,
        message: `Updated ${results.successful.length} of ${ids.length} job seekers`,
        results,
      });
    } catch (error) {
      console.error("=== BULK UPDATE FATAL ERROR ===");
      console.error("Error:", error);
      res.status(500).json({
        success: false,
        message: "An error occurred while bulk updating job seekers",
        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  // Delete job seeker by ID

  async delete(req, res) {
    try {
      const { id } = req.params;

      console.log(`Delete request for job seeker ${id} received`);

      // Get the current user's ID from the auth middleware

      const userId = req.user.id;

      const userRole = req.user.role;

      console.log(`User role: ${userRole}, User ID: ${userId}`);

      const jobSeeker = await this.jobSeekerModel.delete(id, null);

      if (!jobSeeker) {
        console.log("Delete failed - job seeker not found or no permission");

        return res.status(404).json({
          success: false,

          message:
            "Job seeker not found or you do not have permission to delete it",
        });
      }

      console.log("Job seeker deleted successfully:", jobSeeker.id);

      res.status(200).json({
        success: true,

        message: "Job seeker deleted successfully",
      });
    } catch (error) {
      console.error("Error deleting job seeker:", error);

      // Check for specific error types

      if (
        error.message &&
        (error.message.includes("permission") ||
          error.message.includes("not found"))
      ) {
        return res.status(403).json({
          success: false,

          message: error.message,
        });
      }

      res.status(500).json({
        success: false,

        message: "An error occurred while deleting the job seeker",

        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  // Add a note to a job seeker and update last contact date

  async addNote(req, res) {
    try {
      const { id } = req.params;

      const {
        text,
        note_type,
        action,
        about_references,
        aboutReferences,
        email_notification,
      } = req.body;

      if (!text || !text.trim()) {
        return res.status(400).json({
          success: false,

          message: "Note text is required",
        });
      }

      // Get the current user's ID

      const userId = req.user.id;

      // Use about_references or aboutReferences (handle both naming conventions)
      const finalAboutReferences = about_references || aboutReferences;

      console.log(`Adding note to job seeker ${id} by user ${userId}`);

      // Add the note and update last contact date

      const note = await this.jobSeekerModel.addNoteAndUpdateContact(
        id,

        text,

        userId,

        note_type || "General Note",

        action,

        finalAboutReferences,
      );

      // Send email notifications if provided (non-blocking - don't fail note creation if email fails)
      if (
        email_notification &&
        Array.isArray(email_notification) &&
        email_notification.length > 0
      ) {
        try {
          const emailService = require("../services/emailService");
          const jobSeeker = await this.jobSeekerModel.getById(id);
          const User = require("../models/user");
          const userModel = new User(this.jobSeekerModel.pool);
          const currentUser = await userModel.findById(userId);
          const userName = currentUser?.name || "System User";

          const recipients = email_notification.filter(Boolean);

          if (recipients.length > 0) {
            const seekerName = jobSeeker?.fullName || `Job Seeker #${id}`;
            const subject = `New Note Added: ${seekerName}`;
            const htmlContent = `
              <html>
                <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                  <h2 style="color: #2563eb;">New Note Added</h2>
                  <p><strong>Job Seeker:</strong> ${seekerName}</p>
                  ${note_type ? `<p><strong>Note Type:</strong> ${note_type}</p>` : ""}
                  <p><strong>Added by:</strong> ${userName}</p>
                  <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
                  <hr style="border: 1px solid #e5e7eb; margin: 20px 0;">
                  <h3 style="color: #374151;">Note Text:</h3>
                  <div style="background-color: #f9fafb; padding: 15px; border-radius: 5px; white-space: pre-wrap;">${text}</div>
                  <p style="margin-top: 25px;">
                    <a href="${process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/dashboard/job-seekers/view?id=${id}&tab=notes` : `${process.env.NEXT_PUBLIC_BASE_URL}/dashboard/job-seekers/view?id=${id}&tab=notes`}"
                      style="color: #2563eb; text-decoration: underline;"
                      target="_blank"
                    >View This Note Online</a>
                  </p>
                </body>
              </html>
            `;

            await emailService.sendMail({
              to: recipients,
              subject: subject,
              html: htmlContent,
            });

            console.log(
              `Email notifications sent to ${recipients.length} recipient(s) for job seeker note ${note.id}`,
            );
          }
        } catch (emailError) {
          console.error("Error sending email notifications:", emailError);
        }
      }

      return res.status(201).json({
        success: true,

        message: "Note added successfully and last contact date updated",

        note,
      });
    } catch (error) {
      console.error("Error adding note:", error);

      res.status(500).json({
        success: false,

        message: "An error occurred while adding the note",

        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  // Get notes for a job seeker

  async getNotes(req, res) {
    try {
      const { id } = req.params;

      // Get all notes for this job seeker

      const notes = await this.jobSeekerModel.getNotes(id);

      return res.status(200).json({
        success: true,

        count: notes.length,

        notes,
      });
    } catch (error) {
      console.error("Error getting notes:", error);

      res.status(500).json({
        success: false,

        message: "An error occurred while getting notes",

        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  // Get history for a job seeker

  async getHistory(req, res) {
    try {
      const { id } = req.params;

      // Get all history entries for this job seeker

      const history = await this.jobSeekerModel.getHistory(id);

      return res.status(200).json({
        success: true,

        count: history.length,

        history,
      });
    } catch (error) {
      console.error("Error getting history:", error);

      res.status(500).json({
        success: false,

        message: "An error occurred while getting history",

        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  // Get all documents for a job seeker

  async getDocuments(req, res) {
    try {
      const { id } = req.params;

      const documents = await this.documentModel.getByEntity("job_seeker", id);

      return res.status(200).json({
        success: true,

        count: documents.length,

        documents,
      });
    } catch (error) {
      console.error("Error getting documents:", error);

      return res.status(500).json({
        success: false,

        message: "An error occurred while getting documents",

        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  // Get a specific document

  async getDocument(req, res) {
    try {
      const { documentId } = req.params;

      const document = await this.documentModel.getById(documentId);

      if (!document) {
        return res.status(404).json({
          success: false,

          message: "Document not found",
        });
      }

      return res.status(200).json({
        success: true,

        document,
      });
    } catch (error) {
      console.error("Error getting document:", error);

      return res.status(500).json({
        success: false,

        message: "An error occurred while getting the document",

        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  // Add a new document

  async addDocument(req, res) {
    try {
      const { id } = req.params;

      const {
        document_name,
        document_type,
        content,
        file_path,
        file_size,
        mime_type,
      } = req.body;

      if (!document_name) {
        return res.status(400).json({
          success: false,

          message: "Document name is required",
        });
      }

      const userId = req.user.id;

      const document = await this.documentModel.create({
        entity_type: "job_seeker",

        entity_id: id,

        document_name,

        document_type: document_type || "General",

        content: content || null,

        file_path: file_path || null,

        file_size: file_size || null,

        mime_type: mime_type || "text/plain",

        created_by: userId,
      });

      return res.status(201).json({
        success: true,

        message: "Document added successfully",

        document,
      });
    } catch (error) {
      console.error("Error adding document:", error);

      return res.status(500).json({
        success: false,

        message: "An error occurred while adding the document",

        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  // Upload document with file to Vercel Blob
  async uploadDocument(req, res) {
    try {
      const { id } = req.params;
      const { document_name, document_type, file } = req.body || {};

      if (!file) {
        return res
          .status(400)
          .json({ success: false, message: "File is required" });
      }
      if (!document_name) {
        return res
          .status(400)
          .json({ success: false, message: "Document name is required" });
      }

      const base64Data = typeof file === "string" ? file : file.data;
      const mimeType =
        typeof file === "string"
          ? req.body.mime_type || "application/octet-stream"
          : file.type;
      const originalName =
        typeof file === "string" ? req.body.file_name || "document" : file.name;

      if (!base64Data) {
        return res
          .status(400)
          .json({ success: false, message: "File data is missing" });
      }

      const buffer = Buffer.from(base64Data, "base64");
      const userId = req.user.id;
      const timestamp = Date.now();
      const sanitizedName = originalName.replace(/[^a-zA-Z0-9.-]/g, "_");
      const fileName = `job_seekers/${id}/${timestamp}_${sanitizedName}`;

      const blob = await put(fileName, buffer, {
        access: "public",
        contentType: mimeType,
      });

      const document = await this.documentModel.create({
        entity_type: "job_seeker",
        entity_id: id,
        document_name,
        document_type: document_type || "General",
        content: null,
        file_path: blob.url,
        file_size: buffer.length,
        mime_type: mimeType,
        created_by: userId,
      });

      return res.status(201).json({
        success: true,
        message: "Document uploaded successfully",
        document,
      });
    } catch (error) {
      console.error("Error uploading job seeker document:", error);
      return res.status(500).json({
        success: false,
        message: "An error occurred while uploading the document",
        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  // Update a document

  async updateDocument(req, res) {
    try {
      const { documentId } = req.params;

      const updateData = req.body;

      const document = await this.documentModel.update(documentId, updateData);

      if (!document) {
        return res.status(404).json({
          success: false,

          message: "Document not found",
        });
      }

      return res.status(200).json({
        success: true,

        message: "Document updated successfully",

        document,
      });
    } catch (error) {
      console.error("Error updating document:", error);

      return res.status(500).json({
        success: false,

        message: "An error occurred while updating the document",

        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  // Delete a document

  async deleteDocument(req, res) {
    try {
      const { documentId } = req.params;

      const document = await this.documentModel.delete(documentId);

      if (!document) {
        return res.status(404).json({
          success: false,

          message: "Document not found",
        });
      }

      return res.status(200).json({
        success: true,

        message: "Document deleted successfully",
      });
    } catch (error) {
      console.error("Error deleting document:", error);

      return res.status(500).json({
        success: false,

        message: "An error occurred while deleting the document",

        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async getReferences(req, res) {
    try {
      const { id } = req.params;

      const userId = req.user.id;

      const userRole = req.user.role;

      const jobSeeker = await this.jobSeekerModel.getById(id, null);

      if (!jobSeeker) {
        return res.status(404).json({
          success: false,

          message: "Job seeker not found",
        });
      }

      const customFields =
        typeof jobSeeker.custom_fields === "string"
          ? JSON.parse(jobSeeker.custom_fields || "{}")
          : jobSeeker.custom_fields || {};

      const references = Array.isArray(customFields.references)
        ? customFields.references
        : [];

      return res.status(200).json({ success: true, references });
    } catch (error) {
      console.error("Error getting job seeker references:", error);

      return res.status(500).json({
        success: false,

        message: "An error occurred while retrieving references",

        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async addReference(req, res) {
    try {
      const { id } = req.params;

      const userId = req.user.id;

      const reference = req.body || {};

      const jobSeeker = await this.jobSeekerModel.getById(id, null);

      if (!jobSeeker) {
        return res.status(404).json({
          success: false,

          message: "Job seeker not found",
        });
      }

      const customFields =
        typeof jobSeeker.custom_fields === "string"
          ? JSON.parse(jobSeeker.custom_fields || "{}")
          : jobSeeker.custom_fields || {};

      const existing = Array.isArray(customFields.references)
        ? customFields.references
        : [];

      const newReference = {
        id:
          reference.id ||
          `ref_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,

        name: reference.name || "",

        role: reference.role || "",

        company: reference.company || "",

        email: reference.email || "",

        phone: reference.phone || "",

        relationship: reference.relationship || "",

        created_at: new Date().toISOString(),

        created_by: userId,
      };

      const updatedReferences = [...existing, newReference];

      await this.jobSeekerModel.update(
        id,

        { custom_fields: { ...customFields, references: updatedReferences } },

        null,
      );

      return res.status(201).json({
        success: true,

        reference: newReference,

        references: updatedReferences,
      });
    } catch (error) {
      console.error("Error adding job seeker reference:", error);

      return res.status(500).json({
        success: false,

        message: "An error occurred while adding the reference",

        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async deleteReference(req, res) {
    try {
      const { id, referenceId } = req.params;

      const userId = req.user.id;

      const jobSeeker = await this.jobSeekerModel.getById(id, null);

      if (!jobSeeker) {
        return res.status(404).json({
          success: false,

          message: "Job seeker not found",
        });
      }

      const customFields =
        typeof jobSeeker.custom_fields === "string"
          ? JSON.parse(jobSeeker.custom_fields || "{}")
          : jobSeeker.custom_fields || {};

      const existing = Array.isArray(customFields.references)
        ? customFields.references
        : [];

      const updatedReferences = existing.filter(
        (r) => String(r?.id) !== String(referenceId),
      );

      await this.jobSeekerModel.update(
        id,

        { custom_fields: { ...customFields, references: updatedReferences } },

        null,
      );

      return res
        .status(200)
        .json({ success: true, references: updatedReferences });
    } catch (error) {
      console.error("Error deleting job seeker reference:", error);

      return res.status(500).json({
        success: false,

        message: "An error occurred while deleting the reference",

        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }
}

module.exports = JobSeekerController;
