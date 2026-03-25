const Appointment = require('../models/appointment');
const EmailTemplateModel = require('../models/emailTemplateModel');
const { createZoomMeeting, formatZoomDateTime, verifyWebhookSignature } = require('../services/zoomService');
const { sendMail } = require('../services/emailService');
const { renderTemplate } = require('../utils/templateRenderer');
const { put } = require('@vercel/blob');

class AppointmentController {
    constructor(pool) {
        this.appointmentModel = new Appointment(pool);
        this.emailTemplateModel = new EmailTemplateModel(pool);
        this.pool = pool;
        this.create = this.create.bind(this);
        this.getAll = this.getAll.bind(this);
        this.getById = this.getById.bind(this);
        this.update = this.update.bind(this);
        this.delete = this.delete.bind(this);
        this.handleZoomWebhook = this.handleZoomWebhook.bind(this);
    }

    // Initialize database tables
    async initTables() {
        try {
            await this.appointmentModel.initTable();
            console.log('✅ Appointment tables initialized successfully');
        } catch (error) {
            console.error('❌ Error initializing appointment tables:', error);
            throw error;
        }
    }

    // Create a new appointment
    async create(req, res) {
        try {
            // Ensure tables are initialized before creating
            try {
                await this.initTables();
            } catch (initError) {
                console.error('Error initializing tables in create:', initError);
                // Continue anyway - might already exist
            }

            const appointmentData = req.body || {};

            // Coerce common multipart form values (strings) into expected types
            const coerceBool = (v) => {
                if (typeof v === 'boolean') return v;
                if (typeof v !== 'string') return false;
                return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes' || v.toLowerCase() === 'on';
            };
            const coerceInt = (v) => {
                const n = Number(v);
                return Number.isFinite(n) ? n : undefined;
            };
            if (typeof appointmentData.duration === 'string') {
                const n = coerceInt(appointmentData.duration);
                if (n !== undefined) appointmentData.duration = n;
            }
            if (typeof appointmentData.participant_id === 'string') {
                const n = coerceInt(appointmentData.participant_id);
                if (n !== undefined) appointmentData.participant_id = n;
            }
            if (typeof appointmentData.job_id === 'string') {
                const n = coerceInt(appointmentData.job_id);
                if (n !== undefined) appointmentData.job_id = n;
            }
            if (typeof appointmentData.sendInvites === 'string') {
                appointmentData.sendInvites = coerceBool(appointmentData.sendInvites);
            }
            if (typeof appointmentData.send_invites === 'string') {
                appointmentData.send_invites = coerceBool(appointmentData.send_invites);
            }
            if (typeof appointmentData.invitee_emails === 'string') {
                const raw = appointmentData.invitee_emails.trim();
                try {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) appointmentData.invitee_emails = parsed;
                } catch (_) {
                    appointmentData.invitee_emails = raw
                        .split(/[,;]/)
                        .map((s) => s.trim())
                        .filter(Boolean);
                }
            }

            // Validate required fields
            if (!appointmentData.date || !appointmentData.time || !appointmentData.type) {
                return res.status(400).json({
                    success: false,
                    message: 'Date, time, and type are required'
                });
            }

            // Map frontend fields to participant_type and participant_id
            // Frontend may send: job_seeker_id, hiring_manager_id, organization_id
            // Backend expects: participant_type and participant_id
            let participantType = appointmentData.participant_type || appointmentData.participantType;
            let participantId = appointmentData.participant_id || appointmentData.participantId;

            // If not provided directly, try to infer from frontend fields
            if (!participantType || !participantId) {
                if (appointmentData.job_seeker_id) {
                    participantType = 'job_seeker';
                    participantId = appointmentData.job_seeker_id;
                } else if (appointmentData.hiring_manager_id) {
                    participantType = 'hiring_manager';
                    participantId = appointmentData.hiring_manager_id;
                } else if (appointmentData.organization_id) {
                    participantType = 'organization';
                    participantId = appointmentData.organization_id;
                } else if (appointmentData.owner_id || appointmentData.ownerId) {
                    // If no specific participant, use owner as internal participant
                    participantType = 'internal';
                    participantId = appointmentData.owner_id || appointmentData.ownerId;
                }
            }

            // Validate participant_type and participant_id
            if (!participantType) {
                return res.status(400).json({
                    success: false,
                    message: 'participant_type is required (or provide job_seeker_id, hiring_manager_id, or organization_id)'
                });
            }

            if (!participantId) {
                return res.status(400).json({
                    success: false,
                    message: 'participant_id is required (or provide job_seeker_id, hiring_manager_id, or organization_id)'
                });
            }

            // Get owner_id from authenticated user
            const ownerId = req.user?.id || appointmentData.owner_id || appointmentData.ownerId;
            if (!ownerId) {
                return res.status(400).json({
                    success: false,
                    message: 'owner_id is required (from authenticated user or request body)'
                });
            }

            // Validate date/time
            const appointmentDate = new Date(appointmentData.date);
            if (isNaN(appointmentDate.getTime())) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid date format'
                });
            }

            // Validate duration
            const duration = appointmentData.duration || 30;
            if (duration <= 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Duration must be greater than 0'
                });
            }

            // Validate participant_type
            const validParticipantTypes = ['job_seeker', 'hiring_manager', 'organization', 'internal'];
            if (!validParticipantTypes.includes(participantType)) {
                return res.status(400).json({
                    success: false,
                    message: `participant_type must be one of: ${validParticipantTypes.join(', ')}`
                });
            }

            // Verify participant exists (optional but recommended)
            // This will be handled by foreign key constraints in the database

            // Prepare appointment data
            const appointmentPayload = {
                date: appointmentData.date,
                time: appointmentData.time,
                start_time: appointmentData.start_time || appointmentData.time,
                duration: duration,
                type: appointmentData.type,
                participant_type: participantType,
                participant_id: participantId,
                job_id: appointmentData.job_id || appointmentData.jobId || null,
                owner_id: ownerId,
                status: 'scheduled',
                description: appointmentData.description || null
            };

            // Upload attached documents (if any) to Vercel Blob and store URLs
            if (Array.isArray(req.files) && req.files.length > 0) {
                const urls = [];
                for (const f of req.files) {
                    if (!f || !f.buffer) continue;
                    const safeName = String(f.originalname || 'document')
                        .replace(/[^\w.\-() ]+/g, '_')
                        .slice(0, 120);
                    const key = `planner-appointments/${Date.now()}-${Math.random().toString(16).slice(2)}-${safeName}`;
                    try {
                        const uploaded = await put(key, f.buffer, {
                            access: 'public',
                            contentType: f.mimetype || 'application/octet-stream',
                        });
                        if (uploaded?.url) urls.push(uploaded.url);
                    } catch (uploadErr) {
                        console.error('Error uploading appointment document:', uploadErr);
                    }
                }
                if (urls.length > 0) {
                    appointmentPayload.document_urls = urls;
                }
            }

            // If type is 'zoom', create Zoom meeting
            if (appointmentData.type === 'zoom') {
                try {
                    // Get participant name for meeting topic
                    const participantName = await this.appointmentModel.getParticipantName(
                        participantType,
                        participantId
                    );

                    // Get job title if job_id exists
                    let jobTitle = null;
                    const jobId = appointmentData.job_id || appointmentData.jobId;
                    if (jobId) {
                        jobTitle = await this.appointmentModel.getJobTitle(jobId);
                    }

                    // Build meeting topic
                    let topic = 'Meeting';
                    if (jobTitle) {
                        topic = `${jobTitle} - ${participantName}`;
                    } else {
                        topic = `Meeting - ${participantName}`;
                    }

                    // Format datetime for Zoom
                    const zoomStartTime = formatZoomDateTime(
                        appointmentData.date,
                        appointmentData.time || appointmentData.start_time,
                        appointmentData.timezone || 'UTC'
                    );

                    // Create Zoom meeting
                    const zoomMeeting = await createZoomMeeting({
                        topic: topic,
                        start_time: zoomStartTime,
                        duration: duration,
                        timezone: appointmentData.timezone || 'UTC',
                        settings: {
                            join_before_host: appointmentData.join_before_host || false,
                            waiting_room: appointmentData.waiting_room !== false, // Default true
                        }
                    });

                    // Add Zoom meeting data to appointment
                    appointmentPayload.zoom_meeting_id = zoomMeeting.id;
                    appointmentPayload.zoom_join_url = zoomMeeting.join_url;
                    appointmentPayload.zoom_start_url = zoomMeeting.start_url;
                    appointmentPayload.zoom_password = zoomMeeting.password;
                } catch (zoomError) {
                    console.error('Error creating Zoom meeting:', zoomError);
                    // Continue with appointment creation even if Zoom fails
                    // The appointment will be created without Zoom meeting data
                    // In production, you might want to fail the request or handle this differently
                }
            }

            // Create appointment in database
            const appointment = await this.appointmentModel.create(appointmentPayload);

            // Send planner invite emails when requested
            const sendInvites = appointmentData.send_invites === true || appointmentData.sendInvites === true;
            const inviteeEmails = Array.isArray(appointmentData.invitee_emails)
                ? appointmentData.invitee_emails
                : Array.isArray(appointmentData.attendees)
                    ? appointmentData.attendees
                    : [];
            const emailsToNotify = inviteeEmails
                .filter(Boolean)
                .map((e) => (typeof e === 'string' ? e.trim() : (e && e.email) ? e.email : (e && e.address) ? e.address : null))
                .filter((e) => e && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));

            if (sendInvites && emailsToNotify.length > 0) {
                try {
                    const appointmentDate = appointment.date ? new Date(appointment.date).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) : appointmentData.date || '';
                    const appointmentTime = appointment.start_time || appointment.time || appointmentData.time || '';
                    const typeLabel = appointment.type || appointmentData.type || 'Appointment';
                    const description = appointment.description || appointmentData.description || '';
                    const duration = appointment.duration ?? appointmentData.duration ?? 30;
                    const plannerUrl = process.env.FRONTEND_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || '';

                    let tpl = null;
                    try {
                        tpl = await this.emailTemplateModel.getTemplateByType('PLANNER_APPOINTMENT_INVITE');
                    } catch (tplErr) {
                        console.warn('Planner email template not found or error loading:', tplErr.message);
                    }

                    const baseVars = {
                        appointmentDate,
                        appointmentTime,
                        appointmentType: typeLabel,
                        type: typeLabel,
                        description: description || '(No description)',
                        duration: String(duration),
                        plannerUrl: plannerUrl ? `${plannerUrl.replace(/\/$/, '')}/dashboard/planner` : '',
                    };

                    const subject = tpl
                        ? renderTemplate(tpl.subject, baseVars)
                        : `Appointment: ${typeLabel} on ${appointmentDate} at ${appointmentTime}`;
                    const htmlContent = tpl
                        ? renderTemplate(tpl.body, baseVars).replace(/\r\n/g, '\n').replace(/\n/g, '<br/>')
                        : `<p>You are invited to an appointment.</p><p><strong>Date:</strong> ${appointmentDate}<br/><strong>Time:</strong> ${appointmentTime}<br/><strong>Type:</strong> ${typeLabel}</p>${description ? `<p><strong>Details:</strong><br/>${description.replace(/\n/g, '<br/>')}</p>` : ''}`;

                    for (const to of emailsToNotify) {
                        try {
                            const recipientName = to.split('@')[0] || 'there';
                            const perRecipientVars = { ...baseVars, recipientName };
                            const perSubject = tpl ? renderTemplate(tpl.subject, perRecipientVars) : subject;
                            const perHtml = tpl ? renderTemplate(tpl.body, perRecipientVars).replace(/\r\n/g, '\n').replace(/\n/g, '<br/>') : htmlContent;
                            await sendMail({ to, subject: perSubject, html: perHtml });
                        } catch (mailErr) {
                            console.error(`Failed to send planner invite to ${to}:`, mailErr.message);
                        }
                    }
                } catch (inviteErr) {
                    console.error('Error sending planner invite emails:', inviteErr);
                    // Do not fail the request; appointment was already created
                }
            }

            res.status(201).json({
                success: true,
                message: 'Appointment created successfully',
                appointment: appointment
            });
        } catch (error) {
            console.error('Error creating appointment:', error);

            // Handle specific database errors
            if (error.code === '23503') { // Foreign key constraint violation
                return res.status(400).json({
                    success: false,
                    message: 'Referenced record does not exist (owner, participant, or job)'
                });
            }

            if (error.code === '23514') { // Check constraint violation
                return res.status(400).json({
                    success: false,
                    message: 'Invalid participant_type or status value'
                });
            }

            res.status(500).json({
                success: false,
                message: 'An error occurred while creating the appointment',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Get all appointments
    async getAll(req, res) {
        try {
            // Ensure tables are initialized before querying
            try {
                await this.initTables();
            } catch (initError) {
                console.error('Error initializing tables in getAll:', initError);
                // Continue anyway - might already exist
            }

            const filters = {};

            // Extract filters from query parameters
            if (req.query.date) {
                filters.date = req.query.date;
            }

            if (req.query.startDate) {
                filters.startDate = req.query.startDate;
            }

            if (req.query.endDate) {
                filters.endDate = req.query.endDate;
            }

            if (req.query.ownerId) {
                const raw = String(req.query.ownerId);
                if (raw.includes(",")) {
                    filters.ownerIds = raw
                        .split(",")
                        .map((s) => Number(String(s).trim()))
                        .filter((n) => Number.isFinite(n) && n > 0);
                } else {
                    filters.ownerId = req.query.ownerId;
                }
            } else if (req.user && req.user.role !== 'admin' && req.user.role !== 'owner') {
                // Non-admin users only see their own appointments
                filters.ownerId = req.user.id;
            }

            if (req.query.status) {
                filters.status = req.query.status;
            }

            if (req.query.participantType && req.query.participantId) {
                filters.participantType = req.query.participantType;
                filters.participantId = req.query.participantId;
            }

            const appointments = await this.appointmentModel.getAll(filters);

            // Enrich appointments with participant names
            const enrichedAppointments = await Promise.all(
                appointments.map(async (apt) => {
                    try {
                        // Get participant name if participant_type and participant_id exist
                        if (apt.participant_type && apt.participant_id) {
                            const participantName = await this.appointmentModel.getParticipantName(
                                apt.participant_type,
                                apt.participant_id
                            );
                            apt.participant_name = participantName;
                            // Also set client field for backward compatibility
                            if (!apt.client) {
                                apt.client = participantName;
                            }
                        }

                        // Get job title if job_id exists
                        if (apt.job_id && !apt.job && !apt.job_title) {
                            const jobTitle = await this.appointmentModel.getJobTitle(apt.job_id);
                            if (jobTitle) {
                                apt.job_title = jobTitle;
                                apt.job = jobTitle;
                            }
                        }

                        return apt;
                    } catch (error) {
                        console.error(`Error enriching appointment ${apt.id}:`, error);
                        return apt; // Return original if enrichment fails
                    }
                })
            );

            res.json({
                success: true,
                appointments: enrichedAppointments,
                count: enrichedAppointments.length
            });
        } catch (error) {
            console.error('Error getting appointments:', error);
            
            // If table doesn't exist, try to initialize and retry
            if (error.code === '42P01' && error.message.includes('does not exist')) {
                try {
                    console.log('Table does not exist, attempting to initialize...');
                    await this.initTables();
                    // Retry the query
                    const filters = {};
                    if (req.query.startDate) filters.startDate = req.query.startDate;
                    if (req.query.endDate) filters.endDate = req.query.endDate;
                    const appointments = await this.appointmentModel.getAll(filters);
                    return res.json({
                        success: true,
                        appointments: appointments,
                        count: appointments.length
                    });
                } catch (retryError) {
                    console.error('Error retrying after initialization:', retryError);
                }
            }
            
            res.status(500).json({
                success: false,
                message: 'An error occurred while fetching appointments',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Get appointment by ID
    async getById(req, res) {
        try {
            const id = parseInt(req.params.id);

            if (isNaN(id)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid appointment ID'
                });
            }

            const appointment = await this.appointmentModel.getById(id);

            if (!appointment) {
                return res.status(404).json({
                    success: false,
                    message: 'Appointment not found'
                });
            }

            // Check permissions (non-admin users can only see their own appointments)
            if (req.user && req.user.role !== 'admin' && req.user.role !== 'owner') {
                if (appointment.owner_id !== req.user.id) {
                    return res.status(403).json({
                        success: false,
                        message: 'You do not have permission to view this appointment'
                    });
                }
            }

            res.json({
                success: true,
                appointment: appointment
            });
        } catch (error) {
            console.error('Error getting appointment:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while fetching the appointment',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Update appointment
    async update(req, res) {
        try {
            const id = parseInt(req.params.id);

            if (isNaN(id)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid appointment ID'
                });
            }

            // Check if appointment exists
            const existingAppointment = await this.appointmentModel.getById(id);
            if (!existingAppointment) {
                return res.status(404).json({
                    success: false,
                    message: 'Appointment not found'
                });
            }

            // Check permissions
            if (req.user && req.user.role !== 'admin' && req.user.role !== 'owner') {
                if (existingAppointment.owner_id !== req.user.id) {
                    return res.status(403).json({
                        success: false,
                        message: 'You do not have permission to update this appointment'
                    });
                }
            }

            const appointmentData = req.body;

            // Update appointment
            const updatedAppointment = await this.appointmentModel.update(id, appointmentData);

            if (!updatedAppointment) {
                return res.status(404).json({
                    success: false,
                    message: 'Appointment not found'
                });
            }

            res.json({
                success: true,
                message: 'Appointment updated successfully',
                appointment: updatedAppointment
            });
        } catch (error) {
            console.error('Error updating appointment:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while updating the appointment',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Delete appointment
    async delete(req, res) {
        try {
            const id = parseInt(req.params.id);

            if (isNaN(id)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid appointment ID'
                });
            }

            // Check if appointment exists
            const existingAppointment = await this.appointmentModel.getById(id);
            if (!existingAppointment) {
                return res.status(404).json({
                    success: false,
                    message: 'Appointment not found'
                });
            }

            // Check permissions
            if (req.user && req.user.role !== 'admin' && req.user.role !== 'owner') {
                if (existingAppointment.owner_id !== req.user.id) {
                    return res.status(403).json({
                        success: false,
                        message: 'You do not have permission to delete this appointment'
                    });
                }
            }

            const deletedAppointment = await this.appointmentModel.delete(id);

            if (!deletedAppointment) {
                return res.status(404).json({
                    success: false,
                    message: 'Appointment not found'
                });
            }

            res.json({
                success: true,
                message: 'Appointment deleted successfully',
                appointment: deletedAppointment
            });
        } catch (error) {
            console.error('Error deleting appointment:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while deleting the appointment',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Handle Zoom webhook
    async handleZoomWebhook(req, res) {
        try {
            // Get webhook signature and timestamp from headers
            const signature = req.headers['x-zoom-signature-256'];
            const timestamp = req.headers['x-zoom-signature-timestamp'];

            // Get raw body for signature verification
            // Note: In production, use express.raw() middleware for this route
            // For now, we'll stringify the parsed body (signature verification may not work perfectly)
            const rawBody = req.rawBody || JSON.stringify(req.body);

            // Verify webhook signature (if secret token is configured)
            if (process.env.ZOOM_WEBHOOK_SECRET_TOKEN) {
                const isValid = verifyWebhookSignature(rawBody, signature, timestamp);
                if (!isValid) {
                    console.error('❌ Invalid webhook signature');
                    return res.status(401).json({
                        success: false,
                        message: 'Invalid webhook signature'
                    });
                }
            }

            const webhookData = req.body;
            const event = webhookData.event;

            console.log('📥 Zoom webhook received:', event);

            // Handle different webhook events
            if (event === 'meeting.started') {
                const meetingId = webhookData.payload?.object?.id;
                if (meetingId) {
                    // Find appointment by Zoom meeting ID
                    const appointment = await this.appointmentModel.getByZoomMeetingId(meetingId);
                    if (appointment) {
                        // Update status to 'live'
                        await this.appointmentModel.update(appointment.id, { status: 'live' });
                        console.log(`✅ Updated appointment ${appointment.id} status to 'live'`);
                    } else {
                        console.warn(`⚠️ No appointment found for Zoom meeting ID: ${meetingId}`);
                    }
                }
            } else if (event === 'meeting.ended') {
                const meetingId = webhookData.payload?.object?.id;
                if (meetingId) {
                    // Find appointment by Zoom meeting ID
                    const appointment = await this.appointmentModel.getByZoomMeetingId(meetingId);
                    if (appointment) {
                        // Update status to 'completed'
                        await this.appointmentModel.update(appointment.id, { status: 'completed' });
                        console.log(`✅ Updated appointment ${appointment.id} status to 'completed'`);
                    } else {
                        console.warn(`⚠️ No appointment found for Zoom meeting ID: ${meetingId}`);
                    }
                }
            } else if (event === 'meeting.updated') {
                // Handle meeting updates if needed
                console.log('Meeting updated:', webhookData.payload?.object?.id);
            }

            // Always return 200 OK to acknowledge webhook receipt
            res.status(200).json({
                success: true,
                message: 'Webhook received successfully'
            });
        } catch (error) {
            console.error('Error handling Zoom webhook:', error);
            // Still return 200 to prevent Zoom from retrying
            res.status(200).json({
                success: false,
                message: 'Error processing webhook',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }
}

module.exports = AppointmentController;
