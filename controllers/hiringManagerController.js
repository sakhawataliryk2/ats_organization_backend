const HiringManager = require('../models/hiringManager');
const Document = require('../models/document');
const { put } = require('@vercel/blob');
const { normalizeCustomFields, normalizeListCustomFields } = require('../utils/exportHelpers');

class HiringManagerController {
    constructor(pool) {
        this.hiringManagerModel = new HiringManager(pool);
        this.documentModel = new Document(pool);
        this.create = this.create.bind(this);
        this.getAll = this.getAll.bind(this);
        this.getById = this.getById.bind(this);
        this.update = this.update.bind(this);
        this.bulkUpdate = this.bulkUpdate.bind(this);
        this.delete = this.delete.bind(this);
        this.addNote = this.addNote.bind(this);
        this.getNotes = this.getNotes.bind(this);
        this.getHistory = this.getHistory.bind(this);
        this.getByOrganization = this.getByOrganization.bind(this);

        // Bind document methods
        this.getDocuments = this.getDocuments.bind(this);
        this.getDocument = this.getDocument.bind(this);
        this.addDocument = this.addDocument.bind(this);
        this.uploadDocument = this.uploadDocument.bind(this);
        this.updateDocument = this.updateDocument.bind(this);
        this.deleteDocument = this.deleteDocument.bind(this);
    }

    // Initialize database tables
    async initTables() {
        try {
            await this.hiringManagerModel.initTable();
            console.log('✅ Hiring manager tables initialized successfully');
        } catch (error) {
            console.error('❌ Error initializing hiring manager tables:', error);
            throw error;
        }
    }

    // Create a new hiring manager
    async create(req, res) {
        const hiringManagerData = req.body;

        console.log("Create hiring manager request body:", req.body);

        // Basic validation
        // if (!hiringManagerData.firstName || !hiringManagerData.lastName) {
        //     return res.status(400).json({
        //         success: false,
        //         message: 'First name and last name are required'
        //     });
        // }

        // Email validation if provided
        if (hiringManagerData.email) {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(hiringManagerData.email)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid email format'
                });
            }
        }

        // Validate second email if provided
        if (hiringManagerData.email2) {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(hiringManagerData.email2)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid format for second email'
                });
            }
        }

        try {
            // Get the current user's ID from the auth middleware
            const userId = req.user.id;

            // Add userId to the hiring manager data
            hiringManagerData.userId = userId;

            console.log("Attempting to create hiring manager with data:", hiringManagerData);

            // Create hiring manager in database
            const hiringManager = await this.hiringManagerModel.create(hiringManagerData);

            console.log("Hiring manager created successfully:", hiringManager);

            // Send success response
            res.status(201).json({
                success: true,
                message: 'Hiring manager created successfully',
                hiringManager
            });
        } catch (error) {
            console.error('Detailed error creating hiring manager:', error);
            console.error('Error object:', JSON.stringify(error, Object.getOwnPropertyNames(error)));

            // Handle specific database errors
            if (error.code === '23505') { // Unique constraint violation
                return res.status(409).json({
                    success: false,
                    message: 'A hiring manager with this email already exists'
                });
            }

            if (error.code === '23503') { // Foreign key constraint violation
                return res.status(400).json({
                    success: false,
                    message: 'Referenced organization does not exist'
                });
            }

            res.status(500).json({
                success: false,
                message: 'An error occurred while creating the hiring manager',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Get all hiring managers
    async getAll(req, res) {
        try {
            console.log('Getting all hiring managers...');

            // Get the current user's ID from the auth middleware
            const userId = req.user.id;
            const userRole = req.user.role;

            console.log(`User ID: ${userId}, User Role: ${userRole}`);

            const hiringManagers = await this.hiringManagerModel.getAll(null);
            const normalized = normalizeListCustomFields(hiringManagers);

            console.log(`Found ${normalized.length} hiring managers`);

            res.status(200).json({
                success: true,
                count: normalized.length,
                hiringManagers: normalized
            });
        } catch (error) {
            console.error('Error getting hiring managers:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while retrieving hiring managers',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Get hiring manager by ID
    async getById(req, res) {
        try {
            const { id } = req.params;
            console.log(`Getting hiring manager by ID: ${id}`);

            // Validate ID format
            if (!id || isNaN(parseInt(id))) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid hiring manager ID'
                });
            }

            // Get the current user's ID from the auth middleware
            const userId = req.user.id;
            const userRole = req.user.role;

            console.log(`User ID: ${userId}, User Role: ${userRole}`);

            const hiringManager = await this.hiringManagerModel.getById(id, null);

            if (!hiringManager) {
                return res.status(404).json({
                    success: false,
                    message: 'Hiring manager not found or you do not have permission to view it'
                });
            }

            console.log(`Successfully retrieved hiring manager: ${hiringManager.id}`);

            const normalizedHiringManager = normalizeCustomFields(hiringManager);
            res.status(200).json({
                success: true,
                hiringManager: normalizedHiringManager
            });
        } catch (error) {
            console.error('Error getting hiring manager:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while retrieving the hiring manager',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Update hiring manager by ID
    async update(req, res) {
        try {
            const { id } = req.params;
            const updateData = req.body;

            console.log(`Update request for hiring manager ${id} received`);
            console.log("Request user:", req.user);
            console.log("Update data:", JSON.stringify(updateData, null, 2));

            // Validate ID format
            if (!id || isNaN(parseInt(id))) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid hiring manager ID'
                });
            }

            // Validate email format if provided
            if (updateData.email) {
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (!emailRegex.test(updateData.email)) {
                    return res.status(400).json({
                        success: false,
                        message: 'Invalid email format'
                    });
                }
            }

            // Validate second email if provided
            if (updateData.email2) {
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (!emailRegex.test(updateData.email2)) {
                    return res.status(400).json({
                        success: false,
                        message: 'Invalid format for second email'
                    });
                }
            }

            // Get the current user's ID and role from the auth middleware
            const userId = req.user.id;
            const userRole = req.user.role;

            console.log(`User role: ${userRole}, User ID: ${userId}`);

            const hiringManager = await this.hiringManagerModel.update(id, updateData, userId, userRole);

            if (!hiringManager) {
                console.log("Update failed - hiring manager not found or no permission");
                return res.status(404).json({
                    success: false,
                    message: 'Hiring manager not found or you do not have permission to update it'
                });
            }

            console.log("Hiring manager updated successfully:", hiringManager);
            res.status(200).json({
                success: true,
                message: 'Hiring manager updated successfully',
                hiringManager
            });
        } catch (error) {
            console.error('Error updating hiring manager:', error);

            // Handle specific database errors
            if (error.code === '23505') { // Unique constraint violation
                return res.status(409).json({
                    success: false,
                    message: 'A hiring manager with this email already exists'
                });
            }

            if (error.code === '23503') { // Foreign key constraint violation
                return res.status(400).json({
                    success: false,
                    message: 'Referenced organization does not exist'
                });
            }

            // Check for specific error types
            if (error.message && (error.message.includes('permission') || error.message.includes('not found'))) {
                return res.status(403).json({
                    success: false,
                    message: error.message
                });
            }

            res.status(500).json({
                success: false,
                message: 'An error occurred while updating the hiring manager',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Bulk update hiring managers
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
            console.log('Hiring Manager IDs to update:', ids);
            console.log('Updates to apply:', JSON.stringify(updates, null, 2));

            const results = {
                successful: [],
                failed: [],
                errors: []
            };

            // Update each hiring manager
            for (const id of ids) {
                try {
                    console.log(`\n--- Processing hiring manager ${id} ---`);
                    // Clone updates to avoid mutations affecting other iterations
                    const updateData = JSON.parse(JSON.stringify(updates));
                    console.log(`Calling hiringManagerModel.update(${id}, updates, ${userId}, ${userRole})`);
                    console.log(`Updates object:`, JSON.stringify(updates, null, 2));
                    
                    const hiringManager = await this.hiringManagerModel.update(id, updateData, userId, userRole);
                    
                    if (hiringManager) {
                        results.successful.push(id);
                        console.log(`✅ Successfully updated hiring manager ${id}`);
                        console.log(`Updated hiring manager data:`, JSON.stringify({
                            id: hiringManager.id,
                            full_name: hiringManager.full_name,
                            custom_fields: hiringManager.custom_fields
                        }, null, 2));
                    } else {
                        results.failed.push(id);
                        results.errors.push({ id, error: 'Hiring manager not found or permission denied' });
                        console.error(`❌ Failed to update hiring manager ${id}: not found or permission denied`);
                    }
                } catch (error) {
                    results.failed.push(id);
                    const errorMsg = error.message || 'Unknown error';
                    const errorStack = error.stack || 'No stack trace';
                    results.errors.push({ id, error: errorMsg });
                    console.error(`❌ Error updating hiring manager ${id}:`, errorMsg);
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
                message: `Updated ${results.successful.length} of ${ids.length} hiring managers`,
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
                message: 'An error occurred while bulk updating hiring managers',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Delete hiring manager by ID
    async delete(req, res) {
        try {
            const { id } = req.params;
            console.log(`Delete request for hiring manager ${id} received`);

            // Validate ID format
            if (!id || isNaN(parseInt(id))) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid hiring manager ID'
                });
            }

            // Get the current user's ID from the auth middleware
            const userId = req.user.id;
            const userRole = req.user.role;

            console.log(`User role: ${userRole}, User ID: ${userId}`);

            const hiringManager = await this.hiringManagerModel.delete(id, null);

            if (!hiringManager) {
                console.log("Delete failed - hiring manager not found or no permission");
                return res.status(404).json({
                    success: false,
                    message: 'Hiring manager not found or you do not have permission to delete it'
                });
            }

            console.log("Hiring manager deleted successfully:", hiringManager.id);
            res.status(200).json({
                success: true,
                message: 'Hiring manager deleted successfully'
            });
        } catch (error) {
            console.error('Error deleting hiring manager:', error);

            // Check for specific error types
            if (error.message && (error.message.includes('permission') || error.message.includes('not found'))) {
                return res.status(403).json({
                    success: false,
                    message: error.message
                });
            }

            // Handle foreign key constraint errors (if hiring manager is referenced elsewhere)
            if (error.code === '23503') {
                return res.status(409).json({
                    success: false,
                    message: 'Cannot delete hiring manager as it is referenced by other records'
                });
            }

            res.status(500).json({
                success: false,
                message: 'An error occurred while deleting the hiring manager',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Add a note to a hiring manager
    async addNote(req, res) {
        try {
            const { id } = req.params;
            const { text, action, about_references, aboutReferences, email_notification } = req.body;

            // Validate ID format
            if (!id || isNaN(parseInt(id))) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid hiring manager ID'
                });
            }

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
            const note = await this.hiringManagerModel.addNote(id, text, userId, action, finalAboutReferences);

            // Send email notifications if provided (non-blocking - don't fail note creation if email fails)
            if (email_notification && Array.isArray(email_notification) && email_notification.length > 0) {
                try {
                    const emailService = require('../services/emailService');
                    const hiringManager = await this.hiringManagerModel.getById(id);
                    const User = require('../models/user');
                    const userModel = new User(this.hiringManagerModel.pool);
                    const currentUser = await userModel.findById(userId);
                    const userName = currentUser?.name || 'System User';

                    const recipients = email_notification.filter(Boolean);
                    
                    if (recipients.length > 0) {
                        const hmName = hiringManager?.fullName || `Hiring Manager #${id}`;
                        const subject = `New Note Added: ${hmName}`;
                        const htmlContent = `
                            <html>
                                <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                                    <h2 style="color: #2563eb;">New Note Added</h2>
                                    <p><strong>Hiring Manager:</strong> ${hmName}</p>
                                    ${action ? `<p><strong>Action:</strong> ${action}</p>` : ''}
                                    <p><strong>Added by:</strong> ${userName}</p>
                                    <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
                                    <hr style="border: 1px solid #e5e7eb; margin: 20px 0;">
                                    <h3 style="color: #374151;">Note Text:</h3>
                                    <div style="background-color: #f9fafb; padding: 15px; border-radius: 5px; white-space: pre-wrap;">${text}</div>
                                    <p style="margin-top: 25px;">
                                        <a href="${process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/dashboard/hiring-managers/view?id=${id}&tab=notes` : `${process.env.NEXT_PUBLIC_BASE_URL}/dashboard/hiring-managers/view?id=${id}&tab=notes`}"
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

            // Handle case where hiring manager doesn't exist
            if (error.code === '23503') {
                return res.status(404).json({
                    success: false,
                    message: 'Hiring manager not found'
                });
            }

            res.status(500).json({
                success: false,
                message: 'An error occurred while adding the note',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Get notes for a hiring manager
    async getNotes(req, res) {
        try {
            const { id } = req.params;

            console.log(`Getting notes for hiring manager ${id}`);

            // Validate ID format
            if (!id || isNaN(parseInt(id))) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid hiring manager ID'
                });
            }

            // Get all notes for this hiring manager
            const notes = await this.hiringManagerModel.getNotes(id);

            console.log(`Found ${notes.length} notes for hiring manager ${id}`);

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

    // Get history for a hiring manager
    async getHistory(req, res) {
        try {
            const { id } = req.params;

            console.log(`Getting history for hiring manager ${id}`);

            // Validate ID format
            if (!id || isNaN(parseInt(id))) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid hiring manager ID'
                });
            }

            // Get all history entries for this hiring manager
            const history = await this.hiringManagerModel.getHistory(id);

            console.log(`Found ${history.length} history entries for hiring manager ${id}`);

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

    // Additional utility method to get hiring managers by organization
    async getByOrganization(req, res) {
        try {
            const { organizationId } = req.params;

            console.log(`Getting hiring managers for organization ${organizationId}`);

            // Validate organization ID format
            if (!organizationId || isNaN(parseInt(organizationId))) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid organization ID'
                });
            }

            // Get the current user's ID from the auth middleware
            const userId = req.user.id;
            const userRole = req.user.role;

            const hiringManagers = await this.hiringManagerModel.getByOrganization(organizationId, null);

            console.log(`Found ${hiringManagers.length} hiring managers for organization ${organizationId}`);

            res.status(200).json({
                success: true,
                count: hiringManagers.length,
                hiringManagers
            });
        } catch (error) {
            console.error('Error getting hiring managers by organization:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while retrieving hiring managers for the organization',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Search hiring managers
    async search(req, res) {
        try {
            const { query } = req.query;

            console.log(`Searching hiring managers with query: ${query}`);

            if (!query || query.trim().length < 2) {
                return res.status(400).json({
                    success: false,
                    message: 'Search query must be at least 2 characters long'
                });
            }

            // Get the current user's ID from the auth middleware
            const userId = req.user.id;
            const userRole = req.user.role;

            const hiringManagers = await this.hiringManagerModel.search(query.trim(), null);

            console.log(`Found ${hiringManagers.length} hiring managers matching query: ${query}`);

            res.status(200).json({
                success: true,
                count: hiringManagers.length,
                hiringManagers,
                query: query.trim()
            });
        } catch (error) {
            console.error('Error searching hiring managers:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while searching hiring managers',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Get hiring manager statistics
    async getStats(req, res) {
        try {
            console.log('Getting hiring manager statistics...');

            // Get the current user's ID from the auth middleware
            const userId = req.user.id;
            const userRole = req.user.role;

            const stats = await this.hiringManagerModel.getStats(null);

            console.log('Successfully retrieved hiring manager statistics');

            res.status(200).json({
                success: true,
                stats
            });
        } catch (error) {
            console.error('Error getting hiring manager statistics:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while retrieving statistics',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Document methods

    // Get all documents for a hiring manager
    async getDocuments(req, res) {
        try {
            const { id } = req.params;

            // Get all documents for this hiring manager
            const documents = await this.documentModel.getByEntity('hiring_manager', id);

            return res.status(200).json({
                success: true,
                count: documents.length,
                documents
            });
        } catch (error) {
            console.error('Error getting documents:', error);
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
            console.error('Error getting document:', error);
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

            // Get the current user's ID
            const userId = req.user.id;

            // Create the document
            const document = await this.documentModel.create({
                entity_type: 'hiring_manager',
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
            console.error('Error adding document:', error);
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
            const fileName = `hiring_managers/${id}/${timestamp}_${sanitizedName}`;

            const blob = await put(fileName, buffer, { access: 'public', contentType: mimeType });

            const document = await this.documentModel.create({
                entity_type: 'hiring_manager',
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
            console.error('Error uploading document:', error);
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
            console.error('Error updating document:', error);
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
            console.error('Error deleting document:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while deleting the document',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }
}

module.exports = HiringManagerController;