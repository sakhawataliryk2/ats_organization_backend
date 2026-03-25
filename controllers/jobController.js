// controllers/jobController.js
const Job = require('../models/job');
const JobSeeker = require('../models/jobseeker');
const JobSeekerApplication = require("../models/jobSeekerApplication");
const ClientSubmission = require("../models/clientSubmission");
const Document = require('../models/document');
const EmailTemplateModel = require('../models/emailTemplateModel');
const User = require('../models/user');
const { sendMail } = require('../services/emailService');
const { renderTemplate, escapeHtml } = require('../utils/templateRenderer');
const { put } = require('@vercel/blob');
const { normalizeCustomFields, normalizeListCustomFields } = require('../utils/exportHelpers');

/** Find custom_fields key that matches "Distribution list" (case-insensitive, flexible) */
function getDistributionListKey(customFields) {
    if (!customFields || typeof customFields !== 'object') return null;
    const target = 'distribution list';
    for (const key of Object.keys(customFields)) {
        const n = String(key).toLowerCase().replace(/\s+/g, ' ').trim();
        if (n === target || (n.includes('distribution') && n.includes('list'))) return key;
    }
    return null;
}

/** Get array of user IDs from distribution list value (array or comma-separated string) */
function getDistributionUserIds(customFields) {
    const key = getDistributionListKey(customFields);
    if (!key) return [];
    const val = customFields[key];
    if (Array.isArray(val)) return val.map((id) => String(id)).filter(Boolean);
    if (val != null && String(val).trim() !== '') {
        return String(val).split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    }
    return [];
}

class JobController {
    constructor(pool) {
        this.pool = pool;
        this.jobModel = new Job(pool);
        this.documentModel = new Document(pool);
        this.emailTemplateModel = new EmailTemplateModel(pool);
        this.userModel = new User(pool);
        this.applicationModel = new JobSeekerApplication(pool);
        this.clientSubmissionModel = new ClientSubmission(pool);
        this.create = this.create.bind(this);
        this.getAll = this.getAll.bind(this);
        this.getById = this.getById.bind(this);
        this.update = this.update.bind(this);
        this.bulkUpdate = this.bulkUpdate.bind(this);
        this.delete = this.delete.bind(this);
        this.addNote = this.addNote.bind(this);
        this.getNotes = this.getNotes.bind(this);
        this.getHistory = this.getHistory.bind(this);
        this.getApplications = this.getApplications.bind(this);
        this.getClientSubmissions = this.getClientSubmissions.bind(this);
        this.exportToXML = this.exportToXML.bind(this);

        this.importFromXml = this.importFromXml.bind(this);
        this.getAdditionalSkillSuggestions = this.getAdditionalSkillSuggestions.bind(this);

        // Bind document methods
        this.getDocuments = this.getDocuments.bind(this);
        this.getDocument = this.getDocument.bind(this);
        this.addDocument = this.addDocument.bind(this);
        this.uploadDocument = this.uploadDocument.bind(this);
        this.updateDocument = this.updateDocument.bind(this);
        this.deleteDocument = this.deleteDocument.bind(this);
        this.publish = this.publish.bind(this);
        this.jobSeekerModel = new JobSeeker(pool);
        this.aiMatch = this.aiMatch.bind(this);
    }

    /**
     * Check if posting/distribution credentials are configured.
     * When credentials are added (e.g. LINKEDIN_CLIENT_ID, JOB_BOARD_API_KEY), this will return true
     * and the publish flow can perform actual posting.
     */
    _hasPostingCredentials() {
        const hasLinkedIn = !!(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET);
        const hasJobBoard = !!process.env.JOB_BOARD_API_KEY;
        return hasLinkedIn || hasJobBoard;
    }

    /**
     * Send job distribution emails to users in the Distribution list custom field.
     * Uses template type JOB_DISTRIBUTION. Non-blocking; errors are logged only.
     */
    async _sendJobDistributionEmails(jobId, customFields) {
        const userIds = getDistributionUserIds(customFields);
        if (!userIds.length) return;
        try {
            const tpl = await this.emailTemplateModel.getTemplateByType('JOB_DISTRIBUTION');
            if (!tpl || !tpl.subject || !tpl.body) return;
            const job = await this.jobModel.getById(jobId);
            if (!job) return;
            const users = await this.userModel.getUsersByIds(userIds);
            if (!users.length) return;
            const baseUrl = process.env.FRONTEND_URL || process.env.APP_URL || 'http://localhost:3000';
            const jobLink = `${baseUrl}/dashboard/jobs/view?id=${job.id}`;
            const jobTitleText = job.job_title || 'Job';
            const jobTitleLink = '<a href="' + escapeHtml(jobLink) + '">' + escapeHtml(jobTitleText) + '</a>';
            const jobDescriptionText = job.job_description || '';
            const jobDescriptionHtml = jobDescriptionText
                ? escapeHtml(jobDescriptionText).replace(/\r\n/g, '\n').replace(/\n/g, '<br>\n')
                : '';
            const vars = {
                jobTitle: jobTitleText,
                jobTitleLink,
                recordNumber: job.record_number != null ? String(job.record_number) : '',
                jobLink,
                organizationName: job.organization_name || '',
                status: job.status || '',
                employmentType: job.employment_type || '',
                createdByName: job.created_by_name || '',
                jobDescription: jobDescriptionText,
            };
            const subject = renderTemplate(tpl.subject, vars);
            let html = renderTemplate(tpl.body, vars, ['jobLink', 'jobTitleLink']);
            // So plain-text newlines from the admin template show as line breaks in HTML email
            html = html.replace(/\r\n/g, '\n').replace(/\n/g, '<br>\n');
            // Always append full job description so Distribution List emails contain it, regardless of template configuration
            if (jobDescriptionHtml) {
                html += '\n<hr>\n<h3>Job Description</h3>\n<p>' + jobDescriptionHtml + '</p>\n';
            }
            for (const user of users) {
                if (!user.email) continue;
                try {
                    await sendMail({ to: user.email, subject, html });
                } catch (err) {
                    console.error(`Job distribution email failed for user ${user.id}:`, err.message);
                }
            }
        } catch (err) {
            console.error('Job distribution emails error:', err.message);
        }
    }

    // Initialize database tables
    async initTables() {
        await this.jobModel.initTable();
        await this.documentModel.initTable();
        if (this.applicationModel?.initTable) {
            await this.applicationModel.initTable();
        }
        if (this.clientSubmissionModel?.initTable) {
            await this.clientSubmissionModel.initTable();
        }
    }

    // Create a new job
    async create(req, res) {
        // Extract fields explicitly like Organizations (including custom_fields)
        const {
            jobTitle,
            jobType,
            category,
            organizationId,
            organization_id,
            hiringManager,
            status,
            priority,
            employmentType,
            startDate,
            worksiteLocation,
            remoteOption,
            jobDescription,
            salaryType,
            minSalary,
            maxSalary,
            benefits,
            requiredSkills,
            jobBoardStatus,
            owner,
            dateAdded,
            custom_fields, // Extract custom_fields from request
        } = req.body;

        // Small helpers to keep CSV / API inputs robust
        const normalizeDate = (val) => {
            if (!val) return null;
            const s = String(val).trim();
            if (!s) return null;
            // Accept already‑ISO dates
            if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
            // Try to parse anything else and convert to ISO date
            const d = new Date(s);
            if (isNaN(d.getTime())) return null;
            return d.toISOString().split("T")[0];
        };
        const normalizeNumber = (val) => {
            if (val === null || val === undefined || val === "") return null;
            const num = Number(String(val).replace(/,/g, ""));
            return Number.isFinite(num) ? num : null;
        };

        try {
            // Get the current user's ID from the auth middleware
            const userId = req.user.id;

            const resolvedOrganizationId =
                organizationId !== undefined && organizationId !== null && organizationId !== ''
                    ? organizationId
                    : organization_id;

            // Resolve owner: custom_fields first, then top-level owner, then creator (userId)
            const cf = custom_fields || {};
            const ownerFromCustom = cf["Owner"] ?? cf["owner"];
            const resolvedOwner =
                ownerFromCustom !== undefined && ownerFromCustom !== null && String(ownerFromCustom).trim() !== ''
                    ? ownerFromCustom
                    : (owner !== undefined && owner !== null && owner !== '' ? owner : userId);

            // Build model data with custom_fields (same pattern as Organizations)
            const modelData = {
                jobTitle,
                jobType,
                category,
                organizationId: resolvedOrganizationId,
                hiringManager,
                status,
                priority,
                employmentType,
                startDate: normalizeDate(startDate),
                worksiteLocation,
                remoteOption,
                jobDescription,
                salaryType,
                minSalary: normalizeNumber(minSalary),
                maxSalary: normalizeNumber(maxSalary),
                benefits,
                requiredSkills,
                jobBoardStatus,
                owner: resolvedOwner,
                dateAdded: normalizeDate(dateAdded),
                userId,
                custom_fields: custom_fields || {}, // Use snake_case to match model expectation
            };
            
            // Create job in database
            console.log("testcustom_fields:", custom_fields);
            const job = await this.jobModel.create(modelData);

            console.log("Job created successfully:", job);

            // Send distribution emails if Distribution list has recipients (non-blocking)
            this._sendJobDistributionEmails(job.id, custom_fields || {}).catch(() => {});

            // Send success response
            res.status(201).json({
                success: true,
                message: 'Job created successfully',
                job
            });
        } catch (error) {
            console.error('Detailed error creating job:', error);
            // Log the full error object to see all properties
            console.error('Error object:', JSON.stringify(error, Object.getOwnPropertyNames(error)));

            res.status(500).json({
                success: false,
                message: 'An error occurred while creating the job',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    /**
     * POST /jobs/import
     * Bulk create jobs from XML import. No required-field validation.
     * Body: { jobs: Array<{ jobTitle?, jobType?, category?, custom_fields?, ... }> }
     */
    async importFromXml(req, res) {
        const { jobs: jobsPayload } = req.body || {};
        if (!Array.isArray(jobsPayload) || jobsPayload.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Request body must include a non-empty "jobs" array',
            });
        }

        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }

        const results = { created: 0, failed: 0, errors: [] };

        for (let i = 0; i < jobsPayload.length; i++) {
            const row = jobsPayload[i];
            try {
                const custom_fields = row.custom_fields || row.customFields || {};
                const modelData = {
                    jobTitle: row.jobTitle ?? row.job_title ?? '',
                    jobType: row.jobType ?? row.job_type ?? '',
                    category: row.category ?? '',
                    organizationId: row.organizationId ?? row.organization_id ?? null,
                    hiringManager: row.hiringManager ?? row.hiring_manager ?? '',
                    status: row.status ?? 'Open',
                    priority: row.priority ?? null,
                    employmentType: row.employmentType ?? row.employment_type ?? '',
                    startDate: row.startDate ?? row.start_date ?? null,
                    worksiteLocation: row.worksiteLocation ?? row.worksite_location ?? '',
                    remoteOption: row.remoteOption ?? row.remote_option ?? '',
                    jobDescription: row.jobDescription ?? row.job_description ?? '',
                    salaryType: row.salaryType ?? row.salary_type ?? 'yearly',
                    minSalary: row.minSalary ?? row.min_salary ?? null,
                    maxSalary: row.maxSalary ?? row.max_salary ?? null,
                    benefits: row.benefits ?? '',
                    requiredSkills: row.requiredSkills ?? row.required_skills ?? '',
                    jobBoardStatus: row.jobBoardStatus ?? row.job_board_status ?? 'Not Posted',
                    owner: row.owner ?? null,
                    dateAdded: row.dateAdded ?? row.date_added ?? new Date().toISOString().split('T')[0],
                    userId,
                    custom_fields: typeof custom_fields === 'object' && custom_fields !== null ? custom_fields : {},
                };
                await this.jobModel.create(modelData);
                results.created++;
            } catch (err) {
                results.failed++;
                results.errors.push({
                    index: i,
                    message: err?.message || String(err),
                });
            }
        }

        return res.status(200).json({
            success: true,
            ...results,
        });
    }

    // Get all jobs
    async getAll(req, res) {
        try {
            const jobs = await this.jobModel.getAll(null);
            const normalized = normalizeListCustomFields(jobs);

            res.status(200).json({
                success: true,
                count: normalized.length,
                jobs: normalized
            });
        } catch (error) {
            console.error('Error getting jobs:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while retrieving jobs',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Get job by ID
    async getById(req, res) {
        try {
            const { id } = req.params;

            const job = await this.jobModel.getById(id, null);

            if (!job) {
                return res.status(404).json({
                    success: false,
                    message: 'Job not found or you do not have permission to view it'
                });
            }

            const normalizedJob = normalizeCustomFields(job);
            res.status(200).json({
                success: true,
                job: normalizedJob
            });
        } catch (error) {
            console.error('Error getting job:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while retrieving the job',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    /**
     * Get all applications (submissions) for a job, across all job seekers.
     * Backed by the job_seeker_applications table.
     */
    async getApplications(req, res) {
        try {
            const { id } = req.params;

            const job = await this.jobModel.getById(id, null);
            if (!job) {
                return res.status(404).json({
                    success: false,
                    message: "Job not found",
                });
            }

            const applications = await this.applicationModel.getByJobId(id);

            return res.status(200).json({
                success: true,
                count: applications.length,
                applications,
            });
        } catch (error) {
            console.error("Error getting job applications:", error);
            return res.status(500).json({
                success: false,
                message: "An error occurred while retrieving applications",
                error:
                    process.env.NODE_ENV === "production"
                        ? undefined
                        : error.message,
            });
        }
    }

    /**
     * Get all client submissions for a job, across all job seekers.
     * Backed by the client_submissions table.
     */
    async getClientSubmissions(req, res) {
        try {
            const { id } = req.params;

            const job = await this.jobModel.getById(id, null);
            if (!job) {
                return res.status(404).json({
                    success: false,
                    message: "Job not found",
                });
            }

            const submissions = await this.clientSubmissionModel.getByJobId(id);

            return res.status(200).json({
                success: true,
                count: submissions.length,
                submissions,
            });
        } catch (error) {
            console.error("Error getting job client submissions:", error);
            return res.status(500).json({
                success: false,
                message: "An error occurred while retrieving client submissions",
                error:
                    process.env.NODE_ENV === "production"
                        ? undefined
                        : error.message,
            });
        }
    }

    // ENHANCED: Update job by ID with improved debugging
    async update(req, res) {
        try {
            const { id } = req.params;
            const updateData = req.body;

            console.log(`Update request for job ${id} received`);
            console.log("Request user:", req.user);
            console.log("Update data:", JSON.stringify(updateData, null, 2));

            // Get the current user's ID from the auth middleware
            const userId = req.user.id;
            const userRole = req.user.role;

            console.log(`User role: ${userRole}, User ID: ${userId}`);

            // Resolve owner for update: custom_fields first, then top-level owner, then current user
            const cf = updateData.custom_fields || updateData.customFields || {};
            const ownerFromCustom = cf["Owner"] ?? cf["owner"];
            const resolvedOwner =
                ownerFromCustom !== undefined && ownerFromCustom !== null && String(ownerFromCustom).trim() !== ''
                    ? ownerFromCustom
                    : (updateData.owner !== undefined && updateData.owner !== null && updateData.owner !== ''
                        ? updateData.owner
                        : userId);
            updateData.owner = resolvedOwner;

            const job = await this.jobModel.update(id, updateData, null);

            if (!job) {
                console.log("Update failed - job not found or no permission");
                return res.status(404).json({
                    success: false,
                    message: 'Job not found or you do not have permission to update it'
                });
            }

            console.log("Job updated successfully:", job);
            // Send distribution emails if Distribution list has recipients (non-blocking)
            const cf2 = job.custom_fields || updateData.custom_fields || updateData.customFields || {};
            this._sendJobDistributionEmails(id, typeof cf2 === 'string' ? {} : cf2).catch(() => {});

            res.status(200).json({
                success: true,
                message: 'Job updated successfully',
                job
            });
        } catch (error) {
            console.error('Error updating job:', error);

            // Check for specific error types
            if (error.message && (error.message.includes('permission') || error.message.includes('not found'))) {
                return res.status(403).json({
                    success: false,
                    message: error.message
                });
            }

            // In development, include the actual error so the client can show it
            const message = process.env.NODE_ENV === 'production'
                ? 'An error occurred while updating the job'
                : (error.message || 'An error occurred while updating the job');

            res.status(500).json({
                success: false,
                message,
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Bulk update jobs
    async bulkUpdate(req, res) {
        try {
            console.log('=== BULK UPDATE REQUEST START ===');
            console.log('Request body:', JSON.stringify(req.body, null, 2));
            console.log('User ID:', req.user?.id);
            console.log('User:', req.user);
            
            const { ids, updates } = req.body;

            // Validate input
            if (!ids || !Array.isArray(ids) || ids.length === 0) {
                console.error('Validation failed: IDs array is required and must not be empty');
                return res.status(400).json({
                    success: false,
                    message: 'IDs array is required and must not be empty'
                });
            }

            if (!updates || typeof updates !== 'object') {
                console.error('Validation failed: Updates object is required');
                return res.status(400).json({
                    success: false,
                    message: 'Updates object is required'
                });
            }

            // Get the current user's ID and role from the auth middleware
            const userId = req.user.id;
            const userRole = req.user.role;
            console.log('Processing bulk update for user:', userId, 'role:', userRole);
            console.log('Job IDs to update:', ids);
            console.log('Updates to apply:', JSON.stringify(updates, null, 2));

            const results = {
                successful: [],
                failed: [],
                errors: []
            };

            // Update each job
            for (const id of ids) {
                try {
                    console.log(`\n--- Processing job ${id} ---`);
                    // Clone updates to avoid mutations affecting other iterations
                    const updateData = JSON.parse(JSON.stringify(updates));
                    // Resolve owner: custom_fields first, then top-level owner, then current user
                    const cf = updateData.custom_fields || updateData.customFields || {};
                    const ownerFromCustom = cf["Owner"] ?? cf["owner"];
                    const resolvedOwner =
                        ownerFromCustom !== undefined && ownerFromCustom !== null && String(ownerFromCustom).trim() !== ''
                            ? ownerFromCustom
                            : (updateData.owner !== undefined && updateData.owner !== null && updateData.owner !== ''
                                ? updateData.owner
                                : userId);
                    updateData.owner = resolvedOwner;
                    console.log(`Calling jobModel.update(${id}, updates, null)`);
                    console.log(`Updates object:`, JSON.stringify(updates, null, 2));
                    
                    const job = await this.jobModel.update(id, updateData, null);
                    
                    if (job) {
                        results.successful.push(id);
                        console.log(`✅ Successfully updated job ${id}`);
                        console.log(`Updated job data:`, JSON.stringify({
                            id: job.id,
                            job_title: job.job_title,
                            custom_fields: job.custom_fields
                        }, null, 2));
                    } else {
                        results.failed.push(id);
                        results.errors.push({ id, error: 'Job not found or permission denied' });
                        console.error(`❌ Failed to update job ${id}: not found or permission denied`);
                    }
                } catch (error) {
                    results.failed.push(id);
                    const errorMsg = error.message || 'Unknown error';
                    const errorStack = error.stack || 'No stack trace';
                    results.errors.push({ id, error: errorMsg });
                    console.error(`❌ Error updating job ${id}:`, errorMsg);
                    console.error(`Error stack:`, errorStack);
                    console.error(`Full error object:`, error);
                }
            }

            console.log('\n=== BULK UPDATE RESULTS ===');
            console.log(`Successful: ${results.successful.length}/${ids.length}`);
            console.log(`Failed: ${results.failed.length}/${ids.length}`);
            console.log('Results:', JSON.stringify(results, null, 2));
            console.log('=== BULK UPDATE REQUEST END ===\n');

            res.status(200).json({
                success: true,
                message: `Updated ${results.successful.length} of ${ids.length} jobs`,
                results
            });
        } catch (error) {
            console.error('=== BULK UPDATE FATAL ERROR ===');
            console.error('Error:', error);
            console.error('Error message:', error.message);
            console.error('Error stack:', error.stack);
            console.error('=== END FATAL ERROR ===');
            res.status(500).json({
                success: false,
                message: 'An error occurred while bulk updating jobs',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Delete job by ID
    async delete(req, res) {
        try {
            const { id } = req.params;
            console.log(`Delete request for job ${id} received`);

            // Get the current user's ID from the auth middleware
            const userId = req.user.id;
            const userRole = req.user.role;

            console.log(`User role: ${userRole}, User ID: ${userId}`);

            const job = await this.jobModel.delete(id, null);

            if (!job) {
                console.log("Delete failed - job not found or no permission");
                return res.status(404).json({
                    success: false,
                    message: 'Job not found or you do not have permission to delete it'
                });
            }

            console.log("Job deleted successfully:", job.id);
            res.status(200).json({
                success: true,
                message: 'Job deleted successfully'
            });
        } catch (error) {
            console.error('Error deleting job:', error);

            // Check for specific error types
            if (error.message && (error.message.includes('permission') || error.message.includes('not found'))) {
                return res.status(403).json({
                    success: false,
                    message: error.message
                });
            }

            res.status(500).json({
                success: false,
                message: 'An error occurred while deleting the job',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    /**
     * Publish / distribute job to selected targets (LinkedIn, Job Board).
     * Works without credentials: returns success with a message that credentials can be added later.
     * When credentials are configured, this endpoint can be extended to perform actual posting.
     */
    async publish(req, res) {
        try {
            const { id } = req.params;
            const { targets } = req.body || {};
            const targetList = Array.isArray(targets) ? targets : ['job_board'];

            const job = await this.jobModel.getById(id, null);
            if (!job) {
                return res.status(404).json({
                    success: false,
                    message: 'Job not found or you do not have permission to publish it'
                });
            }

            const configured = this._hasPostingCredentials();

            if (!configured) {
                return res.status(200).json({
                    success: true,
                    configured: false,
                    message: 'Distribution is not configured yet. Add your LinkedIn and/or Job Board credentials in Settings to enable posting. Once credentials are added, the same Publish action will post this job to the selected destinations.',
                    targets: targetList,
                    jobBoardStatus: job.job_board_status || 'Not Posted'
                });
            }

            // When credentials exist: wire LinkedIn/Job Board API calls here, then update job_board_status.
            // For now we do not change the job; add actual API calls and then:
            //   await this.jobModel.update(id, { jobBoardStatus: 'Posted', ... }, jobOwner);
            return res.status(200).json({
                success: true,
                configured: true,
                message: 'Credentials are set. Posting to selected destinations can be completed by wiring the LinkedIn and Job Board API calls in this endpoint.',
                targets: targetList,
                jobBoardStatus: job.job_board_status || 'Not Posted'
            });
        } catch (error) {
            console.error('Error in publish:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while publishing the job',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Add a note to a job
    async addNote(req, res) {
        try {
            const { id } = req.params;
            const { text, action, about_references, aboutReferences, email_notification } = req.body;

            if (!text || !text.trim()) {
                return res.status(400).json({
                    success: false,
                    message: 'Note text is required'
                });
            }

            // Get the current user's ID
            const userId = req.user.id;

            // Use about_references or aboutReferences (handle both naming conventions)
            const finalAboutReferences = about_references || aboutReferences;

            // Add the note
            const note = await this.jobModel.addNote(id, text, userId, action, finalAboutReferences);

            // Send email notifications if provided (non-blocking - don't fail note creation if email fails)
            if (email_notification && Array.isArray(email_notification) && email_notification.length > 0) {
                try {
                    const emailService = require('../services/emailService');
                    const job = await this.jobModel.getById(id);
                    const User = require('../models/user');
                    const userModel = new User(this.jobModel.pool);
                    const currentUser = await userModel.findById(userId);
                    const userName = currentUser?.name || 'System User';

                    const recipients = email_notification.filter(Boolean);
                    
                    if (recipients.length > 0) {
                        const jobTitle = job?.title || `Job #${id}`;
                        const subject = `New Note Added: ${jobTitle}`;
                        const htmlContent = `
                            <html>
                                <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                                    <h2 style="color: #2563eb;">New Note Added</h2>
                                    <p><strong>Job:</strong> ${jobTitle}</p>
                                    ${action ? `<p><strong>Action:</strong> ${action}</p>` : ''}
                                    <p><strong>Added by:</strong> ${userName}</p>
                                    <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
                                    <hr style="border: 1px solid #e5e7eb; margin: 20px 0;">
                                    <h3 style="color: #374151;">Note Text:</h3>
                                    <div style="background-color: #f9fafb; padding: 15px; border-radius: 5px; white-space: pre-wrap;">${text}</div>
                                    <p style="margin-top: 25px;">
                                        <a href="${process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/dashboard/jobs/view?id=${id}&tab=notes` : `${process.env.NEXT_PUBLIC_BASE_URL}/dashboard/jobs/view?id=${id}&tab=notes`}"
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
                            html: htmlContent
                        });

                        console.log(`Email notifications sent to ${recipients.length} recipient(s) for job note ${note.id}`);
                    }
                } catch (emailError) {
                    console.error('Error sending email notifications:', emailError);
                }
            }

            return res.status(201).json({
                success: true,
                message: 'Note added successfully',
                note
            });
        } catch (error) {
            console.error('Error adding note:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while adding the note',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Get notes for a job
    async getNotes(req, res) {
        try {
            const { id } = req.params;

            // Get all notes for this job
            const notes = await this.jobModel.getNotes(id);

            return res.status(200).json({
                success: true,
                count: notes.length,
                notes
            });
        } catch (error) {
            console.error('Error getting notes:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while getting notes',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Get history for a job
    async getHistory(req, res) {
        try {
            const { id } = req.params;

            // Get all history entries for this job
            const history = await this.jobModel.getHistory(id);

            return res.status(200).json({
                success: true,
                count: history.length,
                history
            });
        } catch (error) {
            console.error('Error getting history:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while getting history',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    async getAdditionalSkillSuggestions(req, res) {
        try {
            const { q, limit } = req.query;
            const suggestions = await this.jobModel.getAdditionalSkillSuggestions(q, limit);

            return res.status(200).json({
                success: true,
                count: suggestions.length,
                suggestions
            });
        } catch (error) {
            console.error('Error getting additional skill suggestions:', error);
            return res.status(500).json({
                success: false,
                message: 'An error occurred while getting skill suggestions',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Document methods

    // Get all documents for a job
    async getDocuments(req, res) {
        try {
            const { id } = req.params;

            const documents = await this.documentModel.getByEntity('job', id);

            return res.status(200).json({
                success: true,
                count: documents.length,
                documents
            });
        } catch (error) {
            console.error('Error getting job documents:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while getting documents',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
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
                    message: 'Document not found'
                });
            }

            return res.status(200).json({
                success: true,
                document
            });
        } catch (error) {
            console.error('Error getting job document:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while getting the document',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Add a new document
    async addDocument(req, res) {
        try {
            const { id } = req.params;
            const { document_name, document_type, content, file_path, file_size, mime_type } = req.body;

            if (!document_name) {
                return res.status(400).json({
                    success: false,
                    message: 'Document name is required'
                });
            }

            const userId = req.user.id;

            const document = await this.documentModel.create({
                entity_type: 'job',
                entity_id: id,
                document_name,
                document_type: document_type || 'General',
                content: content || null,
                file_path: file_path || null,
                file_size: file_size || null,
                mime_type: mime_type || 'text/plain',
                created_by: userId
            });

            // Mirror document to organization if job has an organization_id
            // try {
            //     const userRole = req.user.role;
            //     const job = await this.jobModel.getById(
            //         id,
            //         ['admin', 'owner'].includes(userRole) ? null : userId
            //     );
            //     const organizationId = job?.organization_id;
            //     if (organizationId) {
            //         await this.documentModel.create({
            //             entity_type: 'organization',
            //             entity_id: organizationId,
            //             document_name,
            //             document_type: document_type || 'General',
            //             content: content || null,
            //             file_path: file_path || null,
            //             file_size: file_size || null,
            //             mime_type: mime_type || 'text/plain',
            //             created_by: userId
            //         });
            //     }
            //     console.log("Document mirrored to organization successfully");
            // } catch (mirrorError) {
            //     console.error('Error mirroring job document to organization:', mirrorError);
            // }

            return res.status(201).json({
                success: true,
                message: 'Document added successfully',
                document
            });
        } catch (error) {
            console.error('Error adding job document:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while adding the document',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Upload document with JSON body (base64) to Vercel Blob
    async uploadDocument(req, res) {
        try {
            const { id } = req.params;
            const { document_name, document_type, file } = req.body || {};

            if (!file) {
                return res.status(400).json({ success: false, message: 'File is required' });
            }
            if (!document_name) {
                return res.status(400).json({ success: false, message: 'Document name is required' });
            }

            const base64Data = typeof file === 'string' ? file : file.data;
            const mimeType = typeof file === 'string' ? (req.body.mime_type || 'application/octet-stream') : file.type;
            const originalName = typeof file === 'string' ? (req.body.file_name || 'document') : file.name;

            if (!base64Data) {
                return res.status(400).json({ success: false, message: 'File data is missing' });
            }

            const buffer = Buffer.from(base64Data, 'base64');
            const userId = req.user.id;
            const timestamp = Date.now();
            const sanitizedName = originalName.replace(/[^a-zA-Z0-9.-]/g, '_');
            const fileName = `jobs/${id}/${timestamp}_${sanitizedName}`;

            const blob = await put(fileName, buffer, { access: 'public', contentType: mimeType });

            const document = await this.documentModel.create({
                entity_type: 'job',
                entity_id: id,
                document_name,
                document_type: document_type || 'General',
                content: null,
                file_path: blob.url,
                file_size: buffer.length,
                mime_type: mimeType,
                created_by: userId
            });

            // Mirror to organization if job has organization_id
            try {
                const job = await this.jobModel.getById(id);
                const organizationId = job?.organization_id;
                if (organizationId) {
                    await this.documentModel.create({
                        entity_type: 'organization',
                        entity_id: organizationId,
                        document_name,
                        document_type: document_type || 'General',
                        content: null,
                        file_path: blob.url,
                        file_size: buffer.length,
                        mime_type: mimeType,
                        created_by: userId
                    });
                }
            } catch (mirrorErr) {
                console.error('Error mirroring job document to organization:', mirrorErr);
            }

            return res.status(201).json({
                success: true,
                message: 'Document uploaded successfully',
                document
            });
        } catch (error) {
            console.error('Error uploading job document:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while uploading the document',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
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
                    message: 'Document not found'
                });
            }

            return res.status(200).json({
                success: true,
                message: 'Document updated successfully',
                document
            });
        } catch (error) {
            console.error('Error updating job document:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while updating the document',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
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
                    message: 'Document not found'
                });
            }

            return res.status(200).json({
                success: true,
                message: 'Document deleted successfully'
            });
        } catch (error) {
            console.error('Error deleting job document:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while deleting the document',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Export jobs to XML
    async exportToXML(req, res) {
        try {
            const { ids } = req.query; // Comma-separated job IDs
            const userId = req.user.id;
            const userRole = req.user.role;

            // Parse job IDs
            const jobIds = ids ? ids.split(',').map(id => id.trim()) : [];

            if (jobIds.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'No job IDs provided'
                });
            }

            console.log(`Exporting ${jobIds.length} jobs to XML for user ${userId} (${userRole})`);

            const jobs = await this.jobModel.getByIds(jobIds, null);

            if (jobs.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'No jobs found or you do not have permission to export them'
                });
            }

            console.log(`Found ${jobs.length} jobs to export`);

            // Generate XML
            const xml = this.generateJobXML(jobs);

            // Set headers for XML download
            res.setHeader('Content-Type', 'application/xml; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="jobs_export_${Date.now()}.xml"`);
            res.status(200).send(xml);
        } catch (error) {
            console.error('Error exporting jobs to XML:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while exporting jobs',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }


    // Helper method to generate XML from jobs
    generateJobXML(jobs) {
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        xml += '<jobs>\n';

        jobs.forEach(job => {
            xml += '  <job>\n';

            // Basic Information
            xml += '    <!-- Basic Information -->\n';
            xml += `    <id>${this.escapeXML(job.id)}</id>\n`;
            xml += `    <title>${this.escapeXML(job.job_title)}</title>\n`;
            xml += `    <category>${this.escapeXML(job.category)}</category>\n`;
            xml += `    <status>${this.escapeXML(job.status)}</status>\n`;
            xml += `    <priority>${this.escapeXML(job.priority)}</priority>\n`;
            xml += `    <employmentType>${this.escapeXML(job.employment_type)}</employmentType>\n`;

            // Organization & People
            xml += '    <!-- Organization & People -->\n';
            xml += `    <organization>${this.escapeXML(job.organization_name)}</organization>\n`;
            xml += `    <organizationId>${this.escapeXML(job.organization_id)}</organizationId>\n`;
            xml += `    <hiringManager>${this.escapeXML(job.hiring_manager)}</hiringManager>\n`;
            xml += `    <owner>${this.escapeXML(job.owner)}</owner>\n`;
            xml += `    <createdBy>${this.escapeXML(job.created_by_name)}</createdBy>\n`;

            // Location & Remote
            xml += '    <!-- Location & Remote -->\n';
            xml += `    <location>${this.escapeXML(job.worksite_location)}</location>\n`;
            xml += `    <remoteOption>${this.escapeXML(job.remote_option)}</remoteOption>\n`;

            // Compensation
            xml += '    <!-- Compensation -->\n';
            xml += `    <salaryType>${this.escapeXML(job.salary_type)}</salaryType>\n`;
            xml += `    <minSalary>${this.escapeXML(job.min_salary)}</minSalary>\n`;
            xml += `    <maxSalary>${this.escapeXML(job.max_salary)}</maxSalary>\n`;
            xml += `    <benefits>${this.escapeXML(job.benefits)}</benefits>\n`;

            // Job Details
            xml += '    <!-- Job Details -->\n';
            xml += `    <description>${this.escapeXML(job.job_description)}</description>\n`;
            xml += `    <requiredSkills>${this.escapeXML(job.required_skills)}</requiredSkills>\n`;
            xml += `    <startDate>${this.escapeXML(job.start_date)}</startDate>\n`;

            // Job Board
            xml += '    <!-- Job Board -->\n';
            xml += `    <jobBoardStatus>${this.escapeXML(job.job_board_status)}</jobBoardStatus>\n`;

            // Dates
            xml += '    <!-- Dates -->\n';
            xml += `    <dateAdded>${this.escapeXML(job.date_added)}</dateAdded>\n`;
            xml += `    <createdAt>${this.escapeXML(job.created_at)}</createdAt>\n`;
            xml += `    <updatedAt>${this.escapeXML(job.updated_at)}</updatedAt>\n`;

            // Include custom fields if present (excluding duplicates of main fields)
            if (job.custom_fields) {
                const customFields = typeof job.custom_fields === 'string'
                    ? JSON.parse(job.custom_fields)
                    : job.custom_fields;

                // List of main field names to exclude from custom fields
                const mainFields = [
                    'job title', 'title', 'category', 'status', 'priority',
                    'employment type', 'organization', 'hiring manager', 'owner',
                    'location', 'worksite location', 'remote option', 'salary type',
                    'min salary', 'max salary', 'benefits', 'description',
                    'job description', 'required skills', 'start date',
                    'job board status', 'date added', 'created at', 'updated at'
                ];

                // Filter out custom fields that duplicate main fields
                const filteredCustomFields = Object.entries(customFields).filter(([key]) => {
                    const normalizedKey = key.toLowerCase().trim();
                    return !mainFields.includes(normalizedKey);
                });

                if (filteredCustomFields.length > 0) {
                    xml += '    <!-- Custom Fields -->\n';
                    xml += '    <customFields>\n';
                    filteredCustomFields.forEach(([key, value]) => {
                        xml += `      <field name="${this.escapeXML(key)}">${this.escapeXML(value)}</field>\n`;
                    });
                    xml += '    </customFields>\n';
                }
            }

            xml += '  </job>\n';
        });

        xml += '</jobs>';
        return xml;
    }

    /** In-memory cache for AI match results: key = 'ai-match-${jobId}', value = { matchedIds, expires } */
    static _aiMatchCache = {};
    static _aiMatchCacheTtlMs = 10 * 60 * 1000; // 10 minutes

    /**
     * POST /jobs/:id/ai-match
     * Returns { matchedIds: string[] } - job seeker IDs that best match the job (no DB writes, short-lived cache).
     */
    async aiMatch(req, res) {
        const { id: jobId } = req.params;
        const cacheKey = `ai-match-${jobId}`;

        try {
            // Check cache first
            const cached = JobController._aiMatchCache[cacheKey];
            if (cached && cached.expires > Date.now()) {
                return res.status(200).json({ matchedIds: cached.matchedIds || [] });
            }

            const job = await this.jobModel.getById(jobId, null);
            if (!job) {
                return res.status(404).json({ success: false, message: 'Job not found' });
            }

            let candidates = await this.jobSeekerModel.getAll(null, false); // unarchived only
            if (!candidates || candidates.length === 0) {
                JobController._aiMatchCache[cacheKey] = { matchedIds: [], expires: Date.now() + JobController._aiMatchCacheTtlMs };
                return res.status(200).json({ matchedIds: [] });
            }

            const jobSkills = (job.required_skills || '').toString().toLowerCase();
            const jobSkillsList = jobSkills.split(/[,;]/).map(s => s.trim()).filter(Boolean);

            if (jobSkillsList.length > 0) {
                candidates = candidates.filter(js => {
                    const s = (js.skills || '').toString().toLowerCase();
                    return jobSkillsList.some(skill => s.includes(skill));
                });
            }

            if (candidates.length === 0) {
                JobController._aiMatchCache[cacheKey] = { matchedIds: [], expires: Date.now() + JobController._aiMatchCacheTtlMs };
                return res.status(200).json({ matchedIds: [] });
            }

            candidates = candidates.slice(0, 50);

            const jobCustomFields = job.custom_fields && typeof job.custom_fields === 'object'
                ? job.custom_fields
                : (typeof job.custom_fields === 'string' ? (() => { try { return JSON.parse(job.custom_fields); } catch { return {}; } })() : {});

            const jobForPrompt = {
                title: job.job_title || '',
                description: (job.job_description || '').toString().slice(0, 2000),
                skills: job.required_skills || '',
                experience: (jobCustomFields.experience || jobCustomFields.Experience || '').toString(),
                education: (jobCustomFields.education || jobCustomFields.Education || '').toString(),
                customFields: JSON.stringify(jobCustomFields),
            };

            const candidatesForPrompt = candidates.map(js => {
                const cf = js.custom_fields && typeof js.custom_fields === 'object'
                    ? js.custom_fields
                    : (typeof js.custom_fields === 'string' ? (() => { try { return JSON.parse(js.custom_fields); } catch { return {}; } })() : {});
                return {
                    id: String(js.id),
                    skills: js.skills || '',
                    experience: (cf.experience || cf.Experience || '').toString(),
                    education: (cf.education || cf.Education || '').toString(),
                    summary: (js.resume_text || '').toString().slice(0, 1500),
                    customFields: JSON.stringify(cf),
                };
            });

            const prompt = `You are a professional AI recruitment matching system.

Your task is to analyze a job and a list of candidates, then return ONLY a JSON array of jobSeekerIds that are the best fit.

You must consider:
- Required skills (highest priority)
- Experience level and years
- Education requirements
- Certifications
- Custom fields (very important)
- Industry/domain relevance
- Role similarity
- Overall profile alignment

-------------------------
JOB DETAILS:
Title: ${jobForPrompt.title}
Description: ${jobForPrompt.description}
Required Skills: ${jobForPrompt.skills}
Experience Required: ${jobForPrompt.experience}
Education: ${jobForPrompt.education}
Custom Fields: ${jobForPrompt.customFields}

Custom fields may include dynamic attributes such as:
- Languages
- Tools
- Frameworks
- Certifications
- Location
- Industry
- Availability
- Salary expectation
- Domain expertise
- Or any additional structured field

Treat custom fields as equal or higher priority if marked required.

-------------------------
CANDIDATES:
${JSON.stringify(candidatesForPrompt)}

-------------------------
Matching Instructions:

1. Prioritize required skills match.
2. Match experience years realistically (do not over-qualify juniors for senior roles).
3. Match education only if relevant to role.
4. Strongly consider overlap in custom fields.
5. Prefer candidates whose custom field values align closely with job custom fields.
6. Rank by overall qualification strength.
7. Return maximum 15 IDs.
8. If few strong matches exist, return fewer.
9. If none qualify, return [].

-------------------------
STRICT OUTPUT REQUIREMENTS:

Return ONLY valid JSON.
Return ONLY an array of IDs.
No explanations.
No text.
No markdown.
No comments.
No formatting.

Correct format example:
["id1","id2","id3"]`;

            const apiKey = process.env.OPENROUTER_API_KEY;
            if (!apiKey) {
                console.error('OPENROUTER_API_KEY not set');
                JobController._aiMatchCache[cacheKey] = { matchedIds: [], expires: Date.now() + JobController._aiMatchCacheTtlMs };
                return res.status(200).json({ matchedIds: [] });
            }

            const openRouterRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model: 'stepfun/step-3.5-flash:free',
                    temperature: 0.2,
                    max_tokens: 800,
                    messages: [{ role: 'user', content: prompt }],
                }),
            });

            const openRouterData = await openRouterRes.json().catch(() => ({}));
            const content = openRouterData?.choices?.[0]?.message?.content;
            const validIds = new Set(candidates.map(c => String(c.id)));

            let parsed = [];
            if (content && typeof content === 'string') {
                const trimmed = content.trim().replace(/^```\w*\n?|\n?```$/g, '').trim();
                try {
                    const arr = JSON.parse(trimmed);
                    if (Array.isArray(arr)) {
                        parsed = arr
                            .filter(item => item != null && String(item).trim() !== '')
                            .map(item => String(item).trim())
                            .filter(id => validIds.has(id));
                    }
                } catch (e) {
                    // ignore parse error
                }
            }

            const matchedIds = parsed.slice(0, 15);
            JobController._aiMatchCache[cacheKey] = {
                matchedIds,
                expires: Date.now() + JobController._aiMatchCacheTtlMs,
            };
            return res.status(200).json({ matchedIds });
        } catch (err) {
            console.error('aiMatch error:', err);
            return res.status(200).json({ matchedIds: [] });
        }
    }

    // Helper to escape XML special characters
    escapeXML(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }
}

module.exports = JobController;