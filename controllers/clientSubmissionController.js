const ClientSubmission = require("../models/clientSubmission");
const JobSeeker = require("../models/jobseeker");
const Job = require("../models/job");
const User = require("../models/user");
const EmailTemplateModel = require("../models/emailTemplateModel");
const { sendMail } = require("../services/emailService");
const { escapeHtml } = require("../utils/templateRenderer");
const { resolveRecordOwnerUserId } = require("../utils/ownerHelpers");

class ClientSubmissionController {
  constructor(pool) {
    this.pool = pool;
    this.model = new ClientSubmission(pool);
    this.jobSeekerModel = new JobSeeker(pool);
    this.jobModel = new Job(pool);
    this.userModel = new User(pool);
    this.emailTemplateModel = new EmailTemplateModel(pool);

    this.initTables = this.initTables.bind(this);
    this.getByJobSeeker = this.getByJobSeeker.bind(this);
    this.createForJobSeeker = this.createForJobSeeker.bind(this);
    this.getByJob = this.getByJob.bind(this);
  }

  async initTables() {
    await this.model.initTable();
  }

  async getByJobSeeker(req, res) {
    try {
      const { id } = req.params;
      const scope = (req.query?.scope || "").toString();
      const scopeUserId =
        scope === "current-user" && req.user?.id ? req.user.id : null;
      const submissions = await this.model.getByJobSeekerId(id, scopeUserId);
      return res.status(200).json({
        success: true,
        count: submissions.length,
        submissions,
      });
    } catch (error) {
      console.error("Error getting client submissions for job seeker:", error);
      return res.status(500).json({
        success: false,
        message: "An error occurred while retrieving client submissions",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async getByJob(req, res) {
    try {
      const { id } = req.params;
      const submissions = await this.model.getByJobId(id);
      return res.status(200).json({
        success: true,
        count: submissions.length,
        submissions,
      });
    } catch (error) {
      console.error("Error getting client submissions for job:", error);
      return res.status(500).json({
        success: false,
        message: "An error occurred while retrieving client submissions for job",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async createForJobSeeker(req, res) {
    try {
      const { id } = req.params;
      const userId = req.user?.id || null;
      const body = req.body || {};

      const jobSeeker = await this.jobSeekerModel.getById(id, null);
      if (!jobSeeker) {
        return res.status(404).json({
          success: false,
          message: "Job seeker not found",
        });
      }

      if (!body.job_id) {
        return res.status(400).json({
          success: false,
          message: "job_id is required for client submission",
        });
      }

      // Prevent duplicate client submissions for the same job seeker + job.
      try {
        const alreadyExists = await this.model.existsForJobSeekerAndJob(
          parseInt(id, 10),
          body.job_id
        );
        if (alreadyExists) {
          return res.status(400).json({
            success: false,
            message:
              "This job seeker has already been submitted to this job as a client submission.",
          });
        }
      } catch (dupErr) {
        console.error(
          "[ClientSubmission] duplicate check failed:",
          dupErr && dupErr.message ? dupErr.message : dupErr
        );
      }

      // Resolve job + organization from jobs table, if possible
      let resolvedJobTitle = body.job_title || "";
      let resolvedOrganizationId =
        body.organization_id !== undefined ? body.organization_id : null;
      let resolvedOrganizationName = body.organization_name || "";

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
            [body.job_id]
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
          client.release();
        }
      } catch (err) {
        console.error(
          "[ClientSubmission] Error resolving job organization for client submission:",
          err && err.message ? err.message : err
        );
      }

      // attachment_ids and documents are optional; submission is allowed without attachments
      const created = await this.model.create({
        job_seeker_id: parseInt(id, 10),
        job_id: body.job_id,
        job_title: resolvedJobTitle,
        organization_id: resolvedOrganizationId,
        organization_name: resolvedOrganizationName,
        status: body.status || "Client Submission",
        submission_source: body.submission_source || body.submissionSource || "",
        comments: body.comments || "",
        comments_html: body.comments_html || "",
        attachment_ids: body.attachment_ids || [],
        hiring_manager_ids: body.hiring_manager_ids || [],
        internal_email_notification: body.internal_email_notification || "",
        submitted_by_name: body.submitted_by_name || body.submittedBy || "",
        submitted_by_email: body.submitted_by_email || body.submittedByEmail || "",
        send_email: !!body.send_email,
        created_by: userId,
      });

      // Update application status (if an application exists) from Submitted -> Client Submission
      try {
        const pool = this.jobSeekerModel.pool;
        const client = await pool.connect();
        try {
          await client.query(
            `
            UPDATE job_seeker_applications
            SET status = $1
            WHERE job_seeker_id = $2
              AND job_id = $3
              AND (status IS NULL OR status = '' OR status = 'Submitted')
            `,
            ["Client Submission", id, body.job_id]
          );
        } finally {
          client.release();
        }
      } catch (statusErr) {
        console.error(
          "[ClientSubmission] Failed to update application status to Client Submission:",
          statusErr && statusErr.message ? statusErr.message : statusErr
        );
      }

      // Auto-generated notes on job seeker and job for "Client Submission", and email to record owners
      try {
        const jobId = body.job_id ? parseInt(body.job_id, 10) : null;
        const jobSeekerId = parseInt(id, 10);
        if (jobId && !Number.isNaN(jobSeekerId)) {
          const jobRecord = await this.jobModel.getById(jobId, null);
          if (jobRecord) {
            const jobSeekerName =
              `${(jobSeeker.first_name || "").trim()} ${(jobSeeker.last_name || "").trim()}`.trim() ||
              jobSeeker.full_name ||
              `Job Seeker #${id}`;
            const jobDisplay =
              jobRecord.record_number != null
                ? `Job #${jobRecord.record_number}`
                : `Job #${jobRecord.id}`;
            const jobTitleDisplay = jobRecord.job_title
              ? `${jobDisplay} ${jobRecord.job_title}`
              : jobDisplay;
            const newStatus = "Client Submitted";
            const noteTextOnJobSeeker = `Application status set to ${newStatus} for ${jobTitleDisplay}.`;
            const noteTextOnJob = `Job seeker ${jobSeekerName} application status set to ${newStatus}.`;
            const aboutRefJob = [
              { id: String(jobId), type: "Job", display: jobTitleDisplay, value: jobDisplay },
            ];
            const aboutRefJobSeeker = [
              { id: String(id), type: "Job Seeker", display: jobSeekerName, value: jobSeekerName },
            ];
            const performedBy = userId || jobSeeker.created_by || jobRecord.created_by;
            await this.jobSeekerModel.addNoteAndUpdateContact(
              jobSeekerId,
              noteTextOnJobSeeker,
              performedBy,
              "General Note",
              newStatus,
              aboutRefJob
            );
            await this.jobModel.addNote(
              jobId,
              noteTextOnJob,
              performedBy,
              newStatus,
              aboutRefJobSeeker
            );
            const jsOwnerId = resolveRecordOwnerUserId(jobSeeker);
            const jobOwnerId = resolveRecordOwnerUserId(jobRecord);
            const ownerIds = [jsOwnerId, jobOwnerId].filter((uid) => uid != null && uid !== "");
            const uniqueOwnerIds = [...new Set(ownerIds)];
            if (uniqueOwnerIds.length > 0) {
              const users = await this.userModel.getUsersByIds(uniqueOwnerIds);
              const emails = users.map((u) => u.email).filter((e) => e && String(e).trim());
              if (emails.length > 0) {
                const baseUrl =
                  process.env.FRONTEND_URL ||
                  process.env.NEXT_PUBLIC_BASE_URL ||
                  "https://your-ats.com";
                const candidateUrl = `${baseUrl.replace(/\/$/, "")}/dashboard/job-seekers/view?id=${id}`;
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
                await sendMail({ to: emails, subject, html });
              }
            }
          }
        }
      } catch (noteErr) {
        console.error(
          "[ClientSubmission] Auto-notes/email for Client Submitted:",
          noteErr && noteErr.message ? noteErr.message : noteErr
        );
      }

      // Optionally send email notification using sendMail when requested
      if (created.send_email) {
        try {
          const pool = this.jobSeekerModel.pool;
          const client = await pool.connect();
          try {
            const hmIds = Array.isArray(body.hiring_manager_ids)
              ? body.hiring_manager_ids
              : String(body.hiring_manager_ids || "")
                  .split(/[,;]/)
                  .map((s) => s.trim())
                  .filter(Boolean);

            const internalIds = Array.isArray(body.internal_email_notification)
              ? body.internal_email_notification
              : String(body.internal_email_notification || "")
                  .split(/[,;]/)
                  .map((s) => s.trim())
                  .filter(Boolean);

            const hmEmails = [];
            if (hmIds.length > 0) {
              const hmInts = hmIds
                .map((v) => parseInt(v, 10))
                .filter((n) => !Number.isNaN(n));
              if (hmInts.length > 0) {
                const hmRes = await client.query(
                  "SELECT email FROM hiring_managers WHERE id = ANY($1::int[])",
                  [hmInts]
                );
                hmRes.rows.forEach((row) => {
                  if (row.email) hmEmails.push(String(row.email).trim());
                });
              }
            }

            const userEmails = [];
            if (internalIds.length > 0) {
              const userInts = internalIds
                .map((v) => parseInt(v, 10))
                .filter((n) => !Number.isNaN(n));
              if (userInts.length > 0) {
                const userRes = await client.query(
                  "SELECT email FROM users WHERE id = ANY($1::int[])",
                  [userInts]
                );
                userRes.rows.forEach((row) => {
                  if (row.email) userEmails.push(String(row.email).trim());
                });
              }
            }

            const toEmails = [...new Set([...hmEmails, ...userEmails])].filter(
              Boolean
            );

            if (toEmails.length > 0) {
              const candidateName =
                `${jobSeeker.first_name || ""} ${
                  jobSeeker.last_name || ""
                }`.trim() ||
                jobSeeker.full_name ||
                `Candidate #${id}`;
              const jobTitleDisplay =
                resolvedJobTitle || `Job #${body.job_id}`;

              const baseUrl =
                process.env.FRONTEND_URL ||
                process.env.NEXT_PUBLIC_BASE_URL ||
                "https://your-ats.com";
              const candidateUrl = `${baseUrl.replace(
                /\/$/,
                ""
              )}/dashboard/job-seekers/view?id=${id}`;

              const submittedAt = new Date(
                created.created_at
              ).toLocaleString("en-GB", {
                dateStyle: "medium",
                timeStyle: "short",
              });

              const summary =
                (body.comments && String(body.comments).trim()) ||
                "No additional notes provided.";

              // Use admin-managed email template for client submissions
              const tpl =
                (await this.emailTemplateModel.getTemplateByType(
                  "CLIENT_SUBMISSION_EMAIL"
                )) ||
                (await this.emailTemplateModel.getTemplateByType(
                  "JOB_SEEKER_CLIENT_SUBMISSION"
                ));

              if (tpl) {
                const { renderTemplate } = require("../utils/templateRenderer");
                const vars = {
                  candidateName,
                  jobTitle: jobTitleDisplay,
                  submittedBy: created.submitted_by_name || "Recruiter",
                  status: created.status || "Client Submission",
                  submittedAt,
                  comments: summary,
                  candidateUrl,
                };

                const subject = renderTemplate(tpl.subject, vars);
                let html = renderTemplate(tpl.body, vars);
                html = html.replace(/\r\n/g, "\n").replace(/\n/g, "<br/>");

                await sendMail({
                  to: toEmails,
                  subject,
                  html,
                });
              } else {
                // Fallback static email if template is not configured
                const subject = `Client Submission: ${candidateName} → ${jobTitleDisplay}`;
                const html = `
                  <html>
                    <body style="font-family: Arial, sans-serif; line-height:1.6; color:#111827;">
                      <h2 style="color:#111827;">New Client Submission</h2>
                      <p><strong>Candidate:</strong> ${candidateName}</p>
                      <p><strong>Job:</strong> ${jobTitleDisplay}</p>
                      <p><strong>Submitted by:</strong> ${
                        created.submitted_by_name || "Recruiter"
                      }</p>
                      <p><strong>Status:</strong> Client Submission</p>
                      <p><strong>Submitted at:</strong> ${submittedAt}</p>
                      <hr style="border:1px solid #e5e7eb; margin:20px 0;" />
                      <h3 style="margin-bottom:8px;">Summary</h3>
                      <div style="background:#f9fafb; padding:12px; border-radius:6px; white-space:pre-wrap;">
                        ${summary}
                      </div>
                      <p style="margin-top:20px;">
                        <a href="${candidateUrl}" style="color:#2563eb; text-decoration:underline;" target="_blank">
                          View candidate in ATS
                        </a>
                      </p>
                    </body>
                  </html>
                `.trim();

                await sendMail({
                  to: toEmails,
                  subject,
                  html,
                });
              }
            }
          } finally {
            client.release();
          }
        } catch (emailErr) {
          console.error(
            "[ClientSubmission] Failed to send client submission email:",
            emailErr && emailErr.message ? emailErr.message : emailErr
          );
        }
      }

      return res.status(201).json({
        success: true,
        clientSubmission: created,
      });
    } catch (error) {
      console.error("Error creating client submission:", error);
      return res.status(500).json({
        success: false,
        message: "An error occurred while creating the client submission",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }
}

module.exports = ClientSubmissionController;

