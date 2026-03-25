const Lead = require('../models/lead');
const Document = require('../models/document');
const { put } = require('@vercel/blob');
const { normalizeCustomFields, normalizeListCustomFields } = require('../utils/exportHelpers');

class LeadController {
    constructor(pool) {
        this.leadModel = new Lead(pool);
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
        this.search = this.search.bind(this);
        this.getStats = this.getStats.bind(this);
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
            await this.leadModel.initTable();
            await this.documentModel.initTable();
            console.log('✅ Lead tables initialized successfully');
        } catch (error) {
            console.error('❌ Error initializing lead tables:', error);
            throw error;
        }
    }

    // Create a new lead
    async create(req, res) {
        const leadData = req.body;

        console.log("Create lead request body:", req.body);

        // Normalize custom fields (support both camelCase and snake_case)
        if (leadData.customFields && !leadData.custom_fields) {
            leadData.custom_fields = leadData.customFields;
        } else if (!leadData.custom_fields) {
            leadData.custom_fields = {};
        }

        // Ensure relationship IDs are arrays
        if (leadData.hiringManagerIds && !Array.isArray(leadData.hiringManagerIds)) {
            leadData.hiringManagerIds = [];
        }
        if (leadData.jobSeekerIds && !Array.isArray(leadData.jobSeekerIds)) {
            leadData.jobSeekerIds = [];
        }
        if (leadData.jobIds && !Array.isArray(leadData.jobIds)) {
            leadData.jobIds = [];
        }
        if (leadData.placementIds && !Array.isArray(leadData.placementIds)) {
            leadData.placementIds = [];
        }
        if (leadData.opportunityIds && !Array.isArray(leadData.opportunityIds)) {
            leadData.opportunityIds = [];
        }

        // Basic validation
        if (!leadData.firstName || !leadData.lastName) {
            return res.status(400).json({
                success: false,
                message: 'First name and last name are required'
            });
        }

        // Email validation if provided
        if (leadData.email) {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(leadData.email)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid email format'
                });
            }
        }

        // Validate second email if provided
        if (leadData.email2) {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(leadData.email2)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid format for second email'
                });
            }
        }

        try {
            // Get the current user's ID from the auth middleware
            const userId = req.user.id;

            // Add userId to the lead data
            leadData.userId = userId;

            console.log("Attempting to create lead with data:", leadData);

            // Create lead in database
            const lead = await this.leadModel.create(leadData);

            console.log("Lead created successfully:", lead);

            // Send success response
            res.status(201).json({
                success: true,
                message: 'Lead created successfully',
                lead
            });
        } catch (error) {
            console.error('Detailed error creating lead:', error);
            console.error('Error object:', JSON.stringify(error, Object.getOwnPropertyNames(error)));

            // Handle specific database errors
            if (error.code === '23505') { // Unique constraint violation
                return res.status(409).json({
                    success: false,
                    message: 'A lead with this email already exists'
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
                message: 'An error occurred while creating the lead',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Get all leads
    async getAll(req, res) {
        try {
            console.log('Getting all leads...');

            // Get the current user's ID from the auth middleware
            const userId = req.user.id;
            const userRole = req.user.role;

            console.log(`User ID: ${userId}, User Role: ${userRole}`);

            const leads = await this.leadModel.getAll(null);
            const normalized = normalizeListCustomFields(leads);

            console.log(`Found ${normalized.length} leads`);

            res.status(200).json({
                success: true,
                count: normalized.length,
                leads: normalized
            });
        } catch (error) {
            console.error('Error getting leads:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while retrieving leads',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Get lead by ID
    async getById(req, res) {
        try {
            const { id } = req.params;
            console.log(`Getting lead by ID: ${id}`);

            // Validate ID format
            if (!id || isNaN(parseInt(id))) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid lead ID'
                });
            }

            // Get the current user's ID from the auth middleware
            const userId = req.user.id;
            const userRole = req.user.role;

            console.log(`User ID: ${userId}, User Role: ${userRole}`);

            const lead = await this.leadModel.getById(id, null);

            if (!lead) {
                return res.status(404).json({
                    success: false,
                    message: 'Lead not found or you do not have permission to view it'
                });
            }

            console.log(`Successfully retrieved lead: ${lead.id}`);

            const normalizedLead = normalizeCustomFields(lead);
            res.status(200).json({
                success: true,
                lead: normalizedLead
            });
        } catch (error) {
            console.error('Error getting lead:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while retrieving the lead',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Update lead by ID
    async update(req, res) {
        try {
            const { id } = req.params;
            const updateData = req.body;

            console.log(`Update request for lead ${id} received`);
            console.log("Request user:", req.user);
            console.log("Update data:", JSON.stringify(updateData, null, 2));

            // Normalize custom fields (support both camelCase and snake_case)
            if (updateData.customFields && !updateData.custom_fields) {
                updateData.custom_fields = updateData.customFields;
            }

            // Ensure relationship IDs are arrays
            if (updateData.hiringManagerIds !== undefined && !Array.isArray(updateData.hiringManagerIds)) {
                updateData.hiringManagerIds = [];
            }
            if (updateData.jobSeekerIds !== undefined && !Array.isArray(updateData.jobSeekerIds)) {
                updateData.jobSeekerIds = [];
            }
            if (updateData.jobIds !== undefined && !Array.isArray(updateData.jobIds)) {
                updateData.jobIds = [];
            }
            if (updateData.placementIds !== undefined && !Array.isArray(updateData.placementIds)) {
                updateData.placementIds = [];
            }
            if (updateData.opportunityIds !== undefined && !Array.isArray(updateData.opportunityIds)) {
                updateData.opportunityIds = [];
            }

            // Validate ID format
            if (!id || isNaN(parseInt(id))) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid lead ID'
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

            // Get the current user's ID from the auth middleware
            const userId = req.user.id;
            const userRole = req.user.role;

            console.log(`User role: ${userRole}, User ID: ${userId}`);

            const lead = await this.leadModel.update(id, updateData, null);

            if (!lead) {
                console.log("Update failed - lead not found or no permission");
                return res.status(404).json({
                    success: false,
                    message: 'Lead not found or you do not have permission to update it'
                });
            }

            console.log("Lead updated successfully:", lead);
            res.status(200).json({
                success: true,
                message: 'Lead updated successfully',
                lead
            });
        } catch (error) {
            console.error('Error updating lead:', error);

            // Handle specific database errors
            if (error.code === '23505') { // Unique constraint violation
                return res.status(409).json({
                    success: false,
                    message: 'A lead with this email already exists'
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
                message: 'An error occurred while updating the lead',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Bulk update leads
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
                    // Normalize custom fields
                    if (updateData.customFields && !updateData.custom_fields) {
                        updateData.custom_fields = updateData.customFields;
                    }
                    const lead = await this.leadModel.update(id, updateData, null);
                    
                    if (lead) {
                        results.successful.push(id);
                    } else {
                        results.failed.push(id);
                        results.errors.push({ id, error: 'Lead not found or permission denied' });
                    }
                } catch (error) {
                    results.failed.push(id);
                    results.errors.push({ id, error: error.message || 'Unknown error' });
                }
            }

            res.status(200).json({
                success: true,
                message: `Updated ${results.successful.length} of ${ids.length} leads`,
                results
            });
        } catch (error) {
            console.error('=== BULK UPDATE FATAL ERROR ===', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while bulk updating leads',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Delete lead by ID
    async delete(req, res) {
        try {
            const { id } = req.params;
            console.log(`Delete request for lead ${id} received`);

            // Validate ID format
            if (!id || isNaN(parseInt(id))) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid lead ID'
                });
            }

            // Get the current user's ID from the auth middleware
            const userId = req.user.id;
            const userRole = req.user.role;

            console.log(`User role: ${userRole}, User ID: ${userId}`);

            const lead = await this.leadModel.delete(id, null);

            if (!lead) {
                console.log("Delete failed - lead not found or no permission");
                return res.status(404).json({
                    success: false,
                    message: 'Lead not found or you do not have permission to delete it'
                });
            }

            console.log("Lead deleted successfully:", lead.id);
            res.status(200).json({
                success: true,
                message: 'Lead deleted successfully'
            });
        } catch (error) {
            console.error('Error deleting lead:', error);

            // Check for specific error types
            if (error.message && (error.message.includes('permission') || error.message.includes('not found'))) {
                return res.status(403).json({
                    success: false,
                    message: error.message
                });
            }

            // Handle foreign key constraint errors (if lead is referenced elsewhere)
            if (error.code === '23503') {
                return res.status(409).json({
                    success: false,
                    message: 'Cannot delete lead as it is referenced by other records'
                });
            }

            res.status(500).json({
                success: false,
                message: 'An error occurred while deleting the lead',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Add a note to a lead
    async addNote(req, res) {
        try {
            const { id } = req.params;
            const { text, action, about_references, aboutReferences } = req.body;

            console.log(`Adding note to lead ${id}`);

            // Validate ID format
            if (!id || isNaN(parseInt(id))) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid lead ID'
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

            // Add the note and update last contact date
            const note = await this.leadModel.addNote(id, text, userId, action, finalAboutReferences);

            console.log("Note added successfully:", note);

            return res.status(201).json({
                success: true,
                message: 'Note added successfully and last contact date updated',
                note
            });
        } catch (error) {
            console.error('Error adding note:', error);

            // Handle case where lead doesn't exist
            if (error.code === '23503') {
                return res.status(404).json({
                    success: false,
                    message: 'Lead not found'
                });
            }

            res.status(500).json({
                success: false,
                message: 'An error occurred while adding the note',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Get notes for a lead
    async getNotes(req, res) {
        try {
            const { id } = req.params;

            console.log(`Getting notes for lead ${id}`);

            // Validate ID format
            if (!id || isNaN(parseInt(id))) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid lead ID'
                });
            }

            // Get all notes for this lead
            const notes = await this.leadModel.getNotes(id);

            console.log(`Found ${notes.length} notes for lead ${id}`);

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

    // Get history for a lead
    async getHistory(req, res) {
        try {
            const { id } = req.params;

            console.log(`Getting history for lead ${id}`);

            // Validate ID format
            if (!id || isNaN(parseInt(id))) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid lead ID'
                });
            }

            // Get all history entries for this lead
            const history = await this.leadModel.getHistory(id);

            console.log(`Found ${history.length} history entries for lead ${id}`);

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

    // Get leads by organization
    async getByOrganization(req, res) {
        try {
            const { organizationId } = req.params;

            console.log(`Getting leads for organization ${organizationId}`);

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

            const leads = await this.leadModel.getByOrganization(organizationId, null);

            console.log(`Found ${leads.length} leads for organization ${organizationId}`);

            res.status(200).json({
                success: true,
                count: leads.length,
                leads
            });
        } catch (error) {
            console.error('Error getting leads by organization:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while retrieving leads for the organization',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Search leads
    async search(req, res) {
        try {
            const { query } = req.query;

            console.log(`Searching leads with query: ${query}`);

            if (!query || query.trim().length < 2) {
                return res.status(400).json({
                    success: false,
                    message: 'Search query must be at least 2 characters long'
                });
            }

            // Get the current user's ID from the auth middleware
            const userId = req.user.id;
            const userRole = req.user.role;

            const leads = await this.leadModel.search(query.trim(), null);

            console.log(`Found ${leads.length} leads matching query: ${query}`);

            res.status(200).json({
                success: true,
                count: leads.length,
                leads,
                query: query.trim()
            });
        } catch (error) {
            console.error('Error searching leads:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while searching leads',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Get lead statistics
    async getStats(req, res) {
        try {
            console.log('Getting lead statistics...');

            // Get the current user's ID from the auth middleware
            const userId = req.user.id;
            const userRole = req.user.role;

            const stats = await this.leadModel.getStats(null);

            console.log('Successfully retrieved lead statistics');

            res.status(200).json({
                success: true,
                stats
            });
        } catch (error) {
            console.error('Error getting lead statistics:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while retrieving statistics',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Document routes (same pattern as organization)
    async getDocuments(req, res) {
        try {
            const { id } = req.params;
            const documents = await this.documentModel.getByEntity('lead', id);
            return res.status(200).json({
                success: true,
                count: documents.length,
                documents
            });
        } catch (error) {
            console.error('Error getting lead documents:', error);
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
                return res.status(404).json({ success: false, message: 'Document not found' });
            }
            return res.status(200).json({ success: true, document });
        } catch (error) {
            console.error('Error getting lead document:', error);
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
                return res.status(400).json({ success: false, message: 'Document name is required' });
            }
            const userId = req.user.id;
            const document = await this.documentModel.create({
                entity_type: 'lead',
                entity_id: id,
                document_name,
                document_type: document_type || 'General',
                content: content || null,
                file_path: file_path || null,
                file_size: file_size || null,
                mime_type: mime_type || 'text/plain',
                created_by: userId
            });
            return res.status(201).json({ success: true, message: 'Document added successfully', document });
        } catch (error) {
            console.error('Error adding lead document:', error);
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
            const fileName = `leads/${id}/${timestamp}_${sanitizedName}`;

            const blob = await put(fileName, buffer, { access: 'public', contentType: mimeType });

            const document = await this.documentModel.create({
                entity_type: 'lead',
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
            console.error('Error uploading lead document:', error);
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
                return res.status(404).json({ success: false, message: 'Document not found' });
            }
            return res.status(200).json({ success: true, message: 'Document updated successfully', document });
        } catch (error) {
            console.error('Error updating lead document:', error);
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
                return res.status(404).json({ success: false, message: 'Document not found' });
            }
            return res.status(200).json({ success: true, message: 'Document deleted successfully', document });
        } catch (error) {
            console.error('Error deleting lead document:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while deleting the document',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }
}

module.exports = LeadController;