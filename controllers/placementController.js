// controllers/placementController.js
const Placement = require('../models/placement');
const Document = require('../models/document');
const { put } = require('@vercel/blob');
const { normalizeCustomFields, normalizeListCustomFields } = require('../utils/exportHelpers');

class PlacementController {
    constructor(pool) {
        this.placementModel = new Placement(pool);
        this.documentModel = new Document(pool);
        this.create = this.create.bind(this);
        this.getAll = this.getAll.bind(this);
        this.getById = this.getById.bind(this);
        this.update = this.update.bind(this);
        this.bulkUpdate = this.bulkUpdate.bind(this);
        this.delete = this.delete.bind(this);
        this.getByJobId = this.getByJobId.bind(this);
        this.getByOrganizationId = this.getByOrganizationId.bind(this);
        this.getByJobSeekerId = this.getByJobSeekerId.bind(this);

        this.getDocuments = this.getDocuments.bind(this);
        this.getDocument = this.getDocument.bind(this);
        this.addDocument = this.addDocument.bind(this);
        this.uploadDocument = this.uploadDocument.bind(this);
        this.updateDocument = this.updateDocument.bind(this);
        this.deleteDocument = this.deleteDocument.bind(this);
        this.getHistory = this.getHistory.bind(this);
        this.addNote = this.addNote.bind(this);
        this.getNotes = this.getNotes.bind(this);
    }

    // Initialize database tables
    async initTables() {
        await this.placementModel.initTable();
        await this.documentModel.initTable();
    }

    // Create a new placement
    async create(req, res) {
        const placementData = req.body;

        try {
            // Get the current user's ID from the auth middleware
            const userId = req.user.id;

            // Add userId to the placement data
            placementData.created_by = userId;

            console.log("Attempting to create placement with data:", placementData);

            // Create placement in database
            const placement = await this.placementModel.create(placementData);

            console.log("Placement created successfully:", placement);

            // Send success response
            res.status(201).json({
                success: true,
                message: 'Placement created successfully',
                placement
            });
        } catch (error) {
            console.error('Detailed error creating placement:', error);
            // Handle DB constraint violations (e.g. NOT NULL) with a generic message - validation is driven by admin field config
            const code = error.code || error.constraint;
            const msg = (error.message || '').toLowerCase();
            if (code === '23502' || msg.includes('not-null') || msg.includes('null value')) {
                return res.status(400).json({
                    success: false,
                    message: 'Please ensure all required fields are filled'
                });
            }
            res.status(500).json({
                success: false,
                message: 'An error occurred while creating the placement',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Get all placements
    async getAll(req, res) {
        try {
            // Get the current user's ID from the auth middleware
            const userId = req.user.id;
            const userRole = req.user.role;

            // All users can see all placements
            const placements = await this.placementModel.getAll(null);
            const normalized = normalizeListCustomFields(placements);

            res.status(200).json({
                success: true,
                count: normalized.length,
                placements: normalized
            });
        } catch (error) {
            console.error('Error getting placements:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while retrieving placements',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Get placement by ID
    async getById(req, res) {
        try {
            const { id } = req.params;

            const placement = await this.placementModel.findById(id);

            if (!placement) {
                return res.status(404).json({
                    success: false,
                    message: 'Placement not found'
                });
            }
            console.log("Placement:", placement);
            console.log("Placement archived at:", placement.archivedAt);
            const normalizedPlacement = normalizeCustomFields(placement);
            res.status(200).json({
                success: true,
                placement: normalizedPlacement
            });
        } catch (error) {
            console.error('Error getting placement:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while retrieving the placement',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Get placements by organization ID
    async getByOrganizationId(req, res) {
        try {
            const { organizationId } = req.params;
            if (!organizationId) {
                return res.status(400).json({
                    success: false,
                    message: 'Organization ID is required',
                });
            }
            const userId = req.user.id;
            const userRole = req.user.role;
            const placements = await this.placementModel.findByOrganizationId(
                organizationId,
                null
            );
            res.status(200).json({
                success: true,
                count: placements.length,
                placements,
            });
        } catch (error) {
            console.error('Error getting placements by organization ID:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while retrieving placements',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message,
            });
        }
    }

    // Get placements by job ID
    async getByJobId(req, res) {
        try {
            const { jobId } = req.params;
            const userId = req.user.id;
            const userRole = req.user.role;

            const placements = await this.placementModel.findByJobId(jobId);

            res.status(200).json({
                success: true,
                count: placements.length,
                placements
            });
        } catch (error) {
            console.error('Error getting placements by job ID:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while retrieving placements',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Get placements by job seeker ID
    async getByJobSeekerId(req, res) {
        try {
            const { jobSeekerId } = req.params;
            const userId = req.user.id;
            const userRole = req.user.role;

            const placements = await this.placementModel.findByJobSeekerId(jobSeekerId);

            res.status(200).json({
                success: true,
                count: placements.length,
                placements
            });
        } catch (error) {
            console.error('Error getting placements by job seeker ID:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while retrieving placements',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Update placement
    async update(req, res) {
        try {
            const { id } = req.params;
            const placementData = req.body;
            const userId = req.user.id;
            const userRole = req.user.role;

            console.log("Update request body back:", placementData);

            // Check if placement exists
            const existingPlacement = await this.placementModel.findById(id);

            if (!existingPlacement) {
                return res.status(404).json({
                    success: false,
                    message: 'Placement not found'
                });
            }

            // Normalize: accept both camelCase (startDate) and snake_case (start_date), convert dates to YYYY-MM-DD
            const toDateStr = (v) => {
                if (v === undefined || v === null || v === '') return undefined;
                if (typeof v !== 'string') return v;
                const d = new Date(v);
                return isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
            };
            const rawStart = placementData.start_date ?? placementData.startDate;
            const rawEnd = placementData.end_date ?? placementData.endDate;

            const normalizedData = {
                ...placementData,
                organization_id: placementData.organization_id ?? placementData.organizationId,
                status: placementData.status,
                start_date: rawStart !== undefined ? toDateStr(rawStart) ?? rawStart : undefined,
                end_date: rawEnd !== undefined ? (rawEnd === '' ? null : (toDateStr(rawEnd) ?? rawEnd)) : undefined,
                salary: placementData.salary !== undefined ? (placementData.salary === '' ? null : placementData.salary) : undefined,
                placement_fee_percent: placementData.placement_fee_percent ?? placementData.placementFeePercent,
                placement_fee_flat: placementData.placement_fee_flat ?? placementData.placementFeeFlat,
                days_guaranteed: placementData.days_guaranteed ?? placementData.daysGuaranteed,
                hours_per_day: placementData.hours_per_day ?? placementData.hoursPerDay,
                hours_of_operation: placementData.hours_of_operation ?? placementData.hoursOfOperation,
                pay_rate: placementData.pay_rate ?? placementData.payRate,
                pay_rate_checked: placementData.pay_rate_checked ?? placementData.payRateChecked,
                effective_date: placementData.effective_date ?? placementData.effectiveDate,
                effective_date_checked: placementData.effective_date_checked ?? placementData.effectiveDateChecked,
                overtime_exemption: placementData.overtime_exemption ?? placementData.overtimeExemption,
                internal_email_notification: placementData.internal_email_notification ?? placementData.internalEmailNotification,
            };

            const updatedPlacement = await this.placementModel.update(id, normalizedData, userId);

            res.status(200).json({
                success: true,
                message: 'Placement updated successfully',
                placement: updatedPlacement
            });
        } catch (error) {
            console.error('Error updating placement:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while updating the placement',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Bulk update placements
    async bulkUpdate(req, res) {
        try {
            console.log('=== BULK UPDATE REQUEST START ===');
            console.log('Request body:', JSON.stringify(req.body, null, 2));
            console.log('User ID:', req.user?.id);
            
            const { ids, updates } = req.body;

            if (!ids || !Array.isArray(ids) || ids.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'IDs array is required and must not be empty'
                });
            }

            if (!updates || typeof updates !== 'object') {
                return res.status(400).json({
                    success: false,
                    message: 'Updates object is required'
                });
            }

            const userId = req.user.id;
            const userRole = req.user.role;
            console.log('Processing bulk update for user:', userId, 'role:', userRole);

            const results = {
                successful: [],
                failed: [],
                errors: []
            };

            for (const id of ids) {
                try {
                    const updateData = JSON.parse(JSON.stringify(updates));
                    const placement = await this.placementModel.update(id, updateData, userId);
                    
                    if (placement) {
                        results.successful.push(id);
                    } else {
                        results.failed.push(id);
                        results.errors.push({ id, error: 'Placement not found or permission denied' });
                    }
                } catch (error) {
                    results.failed.push(id);
                    results.errors.push({ id, error: error.message || 'Unknown error' });
                }
            }

            res.status(200).json({
                success: true,
                message: `Updated ${results.successful.length} of ${ids.length} placements`,
                results
            });
        } catch (error) {
            console.error('=== BULK UPDATE FATAL ERROR ===', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while bulk updating placements',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Get history for a placement
    async getHistory(req, res) {
        try {
            const { id } = req.params;
            const userId = req.user.id;
            const userRole = req.user.role;

            const placement = await this.placementModel.findById(id);
            if (!placement) {
                return res.status(404).json({
                    success: false,
                    message: 'Placement not found'
                });
            }

            const history = await this.placementModel.getHistory(id);

            res.status(200).json({
                success: true,
                count: history.length,
                history
            });
        } catch (error) {
            console.error('Error getting placement history:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while getting placement history',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    async addNote(req, res) {
        try {
            const { id } = req.params;
            const { text, action, about_references, aboutReferences, email_notification } = req.body;

            if (!text || !text.trim()) {
                return res.status(400).json({
                    success: false,
                    message: 'Note text is required',
                    errors: { text: 'Note text is required' }
                });
            }

            if (!action || !action.trim()) {
                return res.status(400).json({
                    success: false,
                    message: 'Action is required',
                    errors: { action: 'Action is required' }
                });
            }

            const userId = req.user.id;
            const userRole = req.user.role;
            const placement = await this.placementModel.findById(id);
            if (!placement) {
                return res.status(404).json({
                    success: false,
                    message: 'Placement not found'
                });
            }
            const finalAboutReferences = about_references || aboutReferences;
            const note = await this.placementModel.addNote(id, text, userId, action, finalAboutReferences);

            // Send email notifications if provided (non-blocking - don't fail note creation if email fails)
            if (email_notification && Array.isArray(email_notification) && email_notification.length > 0) {
                try {
                    const emailService = require('../services/emailService');
                    const User = require('../models/user');
                    const userModel = new User(this.placementModel.pool);
                    const currentUser = await userModel.findById(userId);
                    const userName = currentUser?.name || 'System User';

                    const recipients = email_notification.filter(Boolean);
                    
                    if (recipients.length > 0) {
                        const placementDisplay = placement.jobSeekerName && placement.jobTitle 
                            ? `${placement.jobSeekerName} - ${placement.jobTitle}`
                            : `Placement #${id}`;
                        const subject = `New Note Added: ${placementDisplay}`;
                        const htmlContent = `
                            <html>
                                <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                                    <h2 style="color: #2563eb;">New Note Added</h2>
                                    <p><strong>Placement:</strong> ${placementDisplay}</p>
                                    <p><strong>Action:</strong> ${action}</p>
                                    <p><strong>Added by:</strong> ${userName}</p>
                                    <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
                                    <hr style="border: 1px solid #e5e7eb; margin: 20px 0;">
                                    <h3 style="color: #374151;">Note Text:</h3>
                                    <div style="background-color: #f9fafb; padding: 15px; border-radius: 5px; white-space: pre-wrap;">${text}</div>
                                    <p style="margin-top: 25px;">
                                        <a href="${process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/dashboard/placements/view?id=${id}&tab=notes` : `${process.env.NEXT_PUBLIC_BASE_URL}/dashboard/placements/view?id=${id}&tab=notes`}"
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

                        console.log(`Email notifications sent to ${recipients.length} recipient(s) for placement note ${note.id}`);
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

    async getNotes(req, res) {
        try {
            const { id } = req.params;
            const userId = req.user.id;
            const userRole = req.user.role;

            const placement = await this.placementModel.findById(id);
            if (!placement) {
                return res.status(404).json({
                    success: false,
                    message: 'Placement not found'
                });
            }
            const notes = await this.placementModel.getNotes(id);

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

    // Delete placement
    async delete(req, res) {
        try {
            const { id } = req.params;
            const userId = req.user.id;
            const userRole = req.user.role;

            // Check if placement exists
            const existingPlacement = await this.placementModel.findById(id);

            if (!existingPlacement) {
                return res.status(404).json({
                    success: false,
                    message: 'Placement not found'
                });
            }

            // Delete placement
            await this.placementModel.delete(id, userId);

            res.status(200).json({
                success: true,
                message: 'Placement deleted successfully'
            });
        } catch (error) {
            console.error('Error deleting placement:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while deleting the placement',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    async getDocuments(req, res) {
        try {
            const { id } = req.params;

            const documents = await this.documentModel.getByEntity('placement', id);

            return res.status(200).json({
                success: true,
                count: documents.length,
                documents
            });
        } catch (error) {
            console.error('Error getting placement documents:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while getting documents',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

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
            console.error('Error getting placement document:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while getting the document',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

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
                entity_type: 'placement',
                entity_id: id,
                document_name,
                document_type: document_type || 'General',
                content: content || null,
                file_path: file_path || null,
                file_size: file_size || null,
                mime_type: mime_type || 'text/plain',
                created_by: userId
            });

            return res.status(201).json({
                success: true,
                message: 'Document added successfully',
                document
            });
        } catch (error) {
            console.error('Error adding placement document:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while adding the document',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

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
            const fileName = `placements/${id}/${timestamp}_${sanitizedName}`;

            const blob = await put(fileName, buffer, { access: 'public', contentType: mimeType });

            const document = await this.documentModel.create({
                entity_type: 'placement',
                entity_id: id,
                document_name,
                document_type: document_type || 'General',
                content: null,
                file_path: blob.url,
                file_size: buffer.length,
                mime_type: mimeType,
                created_by: userId
            });

            return res.status(201).json({
                success: true,
                message: 'Document uploaded successfully',
                document
            });
        } catch (error) {
            console.error('Error uploading placement document:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while uploading the document',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

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
            console.error('Error updating placement document:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while updating the document',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

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
            console.error('Error deleting placement document:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while deleting the document',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }
}

module.exports = PlacementController;

