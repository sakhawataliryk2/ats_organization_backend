const Organization = require('../models/organization');
const Office = require('../models/office');
const Team = require('../models/team');
const User = require('../models/user');
const Document = require('../models/document');
const Placement = require('../models/placement');
const OrganizationDefaultDocument = require('../models/organizationDefaultDocument');
const TemplateDocument = require('../models/templateDocument');
const { put } = require('@vercel/blob');
const { normalizeCustomFields, normalizeListCustomFields } = require('../utils/exportHelpers');

class OrganizationController {
    constructor(pool) {
        this.organizationModel = new Organization(pool);
        this.officeModel = new Office(pool);
        this.teamModel = new Team(pool);
        this.userModel = new User(pool);
        this.documentModel = new Document(pool);
        this.placementModel = new Placement(pool);
        this.orgDefaultDocModel = new OrganizationDefaultDocument(pool);
        this.templateDocModel = new TemplateDocument(pool);
        this.create = this.create.bind(this);
        this.getAll = this.getAll.bind(this);
        this.getById = this.getById.bind(this);
        this.getWithApprovedPlacements = this.getWithApprovedPlacements.bind(this);
        this.update = this.update.bind(this);
        this.bulkUpdate = this.bulkUpdate.bind(this);
        this.delete = this.delete.bind(this);
        // Bind existing methods
        this.addNote = this.addNote.bind(this);
        this.getNotes = this.getNotes.bind(this);
        this.getHistory = this.getHistory.bind(this);
        // Bind document methods
        this.getDocuments = this.getDocuments.bind(this);
        this.getDocument = this.getDocument.bind(this);
        this.addDocument = this.addDocument.bind(this);
        this.uploadDocument = this.uploadDocument.bind(this);
        this.updateDocument = this.updateDocument.bind(this);
        this.deleteDocument = this.deleteDocument.bind(this);
        this.getSummaryCounts = this.getSummaryCounts.bind(this);
        this.getDependencies = this.getDependencies.bind(this);
    }


    // Initialize database tables
    async initTables() {
        await this.organizationModel.initTable();
        await this.documentModel.initTable();
        await this.orgDefaultDocModel.initTable();
    }

    // Get dependency counts for an organization
    async getDependencies(req, res) {
        console.log('🔍 getDependencies called for organization ID:', req.params.id);
        try {
            const { id } = req.params;
            const dependencyCounts = await this.organizationModel.getDependencyCounts(id);
            console.log('✅ Dependency counts retrieved:', dependencyCounts);
            res.status(200).json({
                success: true,
                counts: dependencyCounts
            });
        } catch (error) {
            console.error('❌ Error getting dependency counts:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to get dependency counts',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Update the create method to properly handle all fields
    // Now let's fix the backend controller - controllers/organizationController.js

    async create(req, res) {
        // IMPORTANT: Ensure we're extracting ALL fields from the request body
        const {
            name,
            nicknames,
            parent_organization, // Use exact snake_case names as received
            website,
            status,
            contract_on_file, // Use exact snake_case names as received
            contract_signed_by, // Use exact snake_case names as received
            date_contract_signed, // Use exact snake_case names as received
            year_founded, // Use exact snake_case names as received
            overview,
            perm_fee, // Use exact snake_case names as received
            num_employees, // Use exact snake_case names as received
            num_offices, // Use exact snake_case names as received
            contact_phone, // Use exact snake_case names as received
            address,
            custom_fields, // ADDED: Extract custom fields from request
            // New fields for office, team, and user creation
            offices,
            teams,
            users
        } = req.body;

        // Basic validation - only name is required
        if (!name || !name.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Organization name is required'
            });
        }

        try {
            // Get the current user's ID from the auth middleware
            const userId = req.user.id;

            // Get user's name for Owner field auto-population
            let userName = null;
            try {
                const userModel = new User(this.pool);
                const user = await userModel.findById(userId);
                if (user && user.name) {
                    userName = user.name;
                }
            } catch (userError) {
                console.error('Error fetching user name for Owner field:', userError);
                // Continue without user name - Owner will be set from custom_fields if provided
            }

            // Ensure custom_fields is an object
            const customFieldsObj = custom_fields || {};

            // Auto-populate Owner field if missing (use authenticated user's name)
            if (!customFieldsObj["Owner"] || (typeof customFieldsObj["Owner"] === 'string' && customFieldsObj["Owner"].trim() === "")) {
                if (userName) {
                    customFieldsObj["Owner"] = userName;
                }
            }

            // Create organization in database - PASS ALL FIELDS DIRECTLY
            // CRITICAL: Log what we're passing to the model
            const modelData = {
                name,
                nicknames,
                parent_organization,
                website,
                status,
                contract_on_file,
                contract_signed_by,
                date_contract_signed,
                year_founded,
                overview,
                perm_fee,
                num_employees,
                num_offices,
                contact_phone,
                address,
                userId,
                custom_fields: customFieldsObj, // FIXED: Use snake_case to match model expectation
            };
            const organization = await this.organizationModel.create(modelData);

            let defaultDocument = null;
            try {
                const welcomeDefault = await this.orgDefaultDocModel.getBySlot('welcome');
                // Direct organization welcome upload (Document Management > Organization section – no link to onboarding)
                if (welcomeDefault?.file_url) {
                    defaultDocument = await this.documentModel.create({
                        entity_type: 'organization',
                        entity_id: organization.id,
                        document_name: welcomeDefault.document_name || welcomeDefault.file_name || 'Welcome Document',
                        document_type: 'Welcome',
                        file_path: welcomeDefault.file_url,
                        file_size: null,
                        mime_type: welcomeDefault.mime_type || 'application/pdf',
                        is_auto_generated: true,
                        content: null,
                        created_by: userId
                    });
                } else if (welcomeDefault?.template_document_id) {
                    const template = await this.templateDocModel.getById(welcomeDefault.template_document_id);
                    if (template?.file_url) {
                        defaultDocument = await this.documentModel.create({
                            entity_type: 'organization',
                            entity_id: organization.id,
                            document_name: template.document_name || 'Welcome Document',
                            document_type: 'Welcome',
                            file_path: template.file_url,
                            file_size: template.file_size || null,
                            mime_type: template.mime_type || 'application/pdf',
                            is_auto_generated: true,
                            content: null,
                            created_by: userId,
                            source_template_document_id: template.id
                        });
                    }
                }
                if (!defaultDocument) {
                    defaultDocument = await this.documentModel.createDefaultOrganizationDocument(
                        organization.id,
                        organization.name,
                        userId
                    );
                }
            } catch (docError) {
                console.error('Error creating default document:', docError);
                // Don't fail organization creation if document creation fails
            }

            const createdEntities = {
                organization,
                offices: [],
                teams: [],
                users: [],
                defaultDocument
            };

            // Create offices if provided
            if (offices && Array.isArray(offices) && offices.length > 0) {
                for (const officeData of offices) {
                    try {
                        const office = await this.officeModel.create({
                            ...officeData,
                            organization_id: organization.id,
                            created_by: userId
                        });
                        createdEntities.offices.push(office);
                    } catch (officeError) {
                        console.error('Error creating office:', officeError);
                        // Continue with other offices even if one fails
                    }
                }
            }

            // Create teams if provided
            if (teams && Array.isArray(teams) && teams.length > 0) {
                for (const teamData of teams) {
                    try {
                        const team = await this.teamModel.create({
                            ...teamData,
                            organization_id: organization.id,
                            created_by: userId
                        });
                        createdEntities.teams.push(team);
                    } catch (teamError) {
                        console.error('Error creating team:', teamError);
                        // Continue with other teams even if one fails
                    }
                }
            }

            // Create users if provided
            if (users && Array.isArray(users) && users.length > 0) {
                for (const userData of users) {
                    try {
                        const user = await this.userModel.create({
                            ...userData,
                            organization_id: organization.id,
                            created_by: userId
                        });
                        createdEntities.users.push(user);
                    } catch (userError) {
                        console.error('Error creating user:', userError);
                        // Continue with other users even if one fails
                    }
                }
            }

            // Send success response with all created entities
            res.status(201).json({
                success: true,
                message: 'Organization and related entities created successfully',
                organization: createdEntities.organization, // Frontend expects this
                data: createdEntities // Keep full data for backward compatibility
            });
        } catch (error) {
            console.error('Error creating organization:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while creating the organization',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Get all organizations (full records for export when ?full=1; always return all columns including custom_fields)
    async getAll(req, res) {
        try {
            const organizations = await this.organizationModel.getAll(null);
            const normalized = normalizeListCustomFields(organizations);

            res.status(200).json({
                success: true,
                count: normalized.length,
                organizations: normalized
            });
        } catch (error) {
            console.error('Error getting organizations:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while retrieving organizations',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Get organization by ID
    async getById(req, res) {
        try {
            const { id } = req.params;

            // Get the current user's ID from the auth middleware
            const userId = req.user.id;
            const userRole = req.user.role;

            const organization = await this.organizationModel.getById(id, null);

            if (!organization) {
                return res.status(404).json({
                    success: false,
                    message: 'Organization not found or you do not have permission to view it'
                });
            }

            // Resolve parent organization: if parent_organization is numeric, treat as org ID and fetch name
            const parentOrgRaw = organization.parent_organization;
            if (parentOrgRaw && typeof parentOrgRaw === 'string' && /^\d+$/.test(parentOrgRaw.trim())) {
                try {
                    const parentOrg = await this.organizationModel.getById(parentOrgRaw.trim(), null);
                    if (parentOrg) {
                        organization.parent_organization_id = parentOrg.id;
                        organization.parent_organization_name = parentOrg.name || parentOrgRaw;
                    }
                } catch (e) {
                    console.error('Error resolving parent organization:', e);
                }
            } else if (parentOrgRaw && (typeof parentOrgRaw === 'string' && parentOrgRaw.trim() !== '')) {
                organization.parent_organization_name = parentOrgRaw;
            }

            const normalizedOrg = normalizeCustomFields(organization);

            res.status(200).json({
                success: true,
                organization: normalizedOrg
            });
        } catch (error) {
            console.error('Error getting organization:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while retrieving the organization',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Get organizations that have at least one placement with status = 'Approved' (for TBI)
    async getWithApprovedPlacements(req, res) {
        try {
            const userId = req.user.id;
            const userRole = req.user.role;
            const orgIds = await this.placementModel.findOrganizationIdsWithApprovedPlacements(null);
            if (orgIds.length === 0) {
                return res.status(200).json({ success: true, count: 0, organizations: [] });
            }
            // Return full org data for each org that has approved placement(s); do not filter org by creator
            const organizations = await this.organizationModel.getByIds(orgIds, null);
            res.status(200).json({
                success: true,
                count: organizations.length,
                organizations
            });
        } catch (error) {
            console.error('Error getting organizations with approved placements:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while retrieving organizations',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Update the update method to properly handle all fields
    async update(req, res) {
        try {
            const { id } = req.params;
            const updateData = req.body;

            // Get the current user's ID and role from the auth middleware
            const userId = req.user.id;
            const userRole = req.user.role;

            const organization = await this.organizationModel.update(id, updateData, userId, userRole);

            if (!organization) {
                return res.status(404).json({
                    success: false,
                    message: 'Organization not found or you do not have permission to update it'
                });
            }

            res.status(200).json({
                success: true,
                message: 'Organization updated successfully',
                organization
            });
        } catch (error) {
            console.error('Error updating organization:', error);

            // Check for specific error types
            if (error.message.includes('permission') || error.message.includes('not found')) {
                return res.status(403).json({
                    success: false,
                    message: error.message
                });
            }

            res.status(500).json({
                success: false,
                message: 'An error occurred while updating the organization',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Bulk update organizations
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
            console.log('Organization IDs to update:', ids);
            console.log('Updates to apply:', JSON.stringify(updates, null, 2));

            const results = {
                successful: [],
                failed: [],
                errors: []
            };

            // Update each organization
            for (const id of ids) {
                try {
                    console.log(`\n--- Processing organization ${id} ---`);
                    // Clone updates to avoid mutations affecting other iterations
                    const updateData = JSON.parse(JSON.stringify(updates));
                    console.log(`Calling organizationModel.update(${id}, updates, ${userId}, ${userRole})`);
                    console.log(`Updates object:`, JSON.stringify(updates, null, 2));
                    
                    const organization = await this.organizationModel.update(id, updateData, userId, userRole);
                    
                    if (organization) {
                        results.successful.push(id);
                        console.log(`✅ Successfully updated organization ${id}`);
                        console.log(`Updated organization data:`, JSON.stringify({
                            id: organization.id,
                            name: organization.name,
                            custom_fields: organization.custom_fields
                        }, null, 2));
                    } else {
                        results.failed.push(id);
                        results.errors.push({ id, error: 'Organization not found or permission denied' });
                        console.error(`❌ Failed to update organization ${id}: not found or permission denied`);
                    }
                } catch (error) {
                    results.failed.push(id);
                    const errorMsg = error.message || 'Unknown error';
                    const errorStack = error.stack || 'No stack trace';
                    results.errors.push({ id, error: errorMsg });
                    console.error(`❌ Error updating organization ${id}:`, errorMsg);
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
                message: `Updated ${results.successful.length} of ${ids.length} organizations`,
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
                message: 'An error occurred while bulk updating organizations',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // New method for adding notes
    async addNote(req, res) {
        try {
            const { id } = req.params;
            const { text, action, about_references, aboutReferences, email_notification } = req.body;

            // Validate required fields
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

            // Get the current user's ID
            const userId = req.user.id;

            // Use about_references or aboutReferences (handle both naming conventions)
            const finalAboutReferences = about_references || aboutReferences;

            // Add the note
            const note = await this.organizationModel.addNote(id, text, userId, action, finalAboutReferences);

            // Send email notifications if provided (non-blocking - don't fail note creation if email fails)
            if (email_notification && Array.isArray(email_notification) && email_notification.length > 0) {
                try {
                    const emailService = require('../services/emailService');
                    const organization = await this.organizationModel.getById(id);

                    // Get current user info for email
                    const User = require('../models/user');
                    const userModel = new User(this.organizationModel.pool);
                    const currentUser = await userModel.findById(userId);
                    const userName = currentUser?.name || 'System User';

                    // Format email recipients (can be email addresses or user names)
                    const recipients = email_notification.filter(Boolean);

                    if (recipients.length > 0) {
                        const orgName = organization?.name || `Organization #${id}`;
                        const subject = `New Note Added: ${orgName}`;
                        const htmlContent = `
                            <html>
                                <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                                    <h2 style="color: #2563eb;">New Note Added</h2>
                                    <p><strong>Organization:</strong> ${orgName}</p>
                                    <p><strong>Action:</strong> ${action}</p>
                                    <p><strong>Added by:</strong> ${userName}</p>
                                    <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
                                    <hr style="border: 1px solid #e5e7eb; margin: 20px 0;">
                                    <h3 style="color: #374151;">Note Text:</h3>
                                    <div style="background-color: #f9fafb; padding: 15px; border-radius: 5px; white-space: pre-wrap;">${text}</div>
                                    <p style="margin-top: 25px;">
                                        <a href="${process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/dashboard/organizations/view?id=${id}&tab=notes` : `${process.env.NEXT_PUBLIC_BASE_URL}/dashboard/organizations/view?id=${id}&tab=notes`}"
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
                    // Log email error but don't fail the note creation
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

    // New method for getting notes
    async getNotes(req, res) {
        try {
            const { id } = req.params;

            // Get all notes for this organization
            const notes = await this.organizationModel.getNotes(id);

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

    // New method for getting history
    async getHistory(req, res) {
        try {
            const { id } = req.params;

            // Get all history entries for this organization
            const history = await this.organizationModel.getHistory(id);

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

    // Fixed delete method to handle permissions correctly
    async delete(req, res) {
        try {
            const { id } = req.params;

            // Get the current user's ID from the auth middleware
            const userId = req.user.id;
            const userRole = req.user.role;

            const organization = await this.organizationModel.delete(id, null);

            if (!organization) {
                return res.status(404).json({
                    success: false,
                    message: 'Organization not found or you do not have permission to delete it'
                });
            }

            res.status(200).json({
                success: true,
                message: 'Organization deleted successfully'
            });
        } catch (error) {
            console.error('Error deleting organization:', error);

            // Check for specific error types
            if (error.message.includes('permission') || error.message.includes('not found')) {
                return res.status(403).json({
                    success: false,
                    message: error.message
                });
            }

            res.status(500).json({
                success: false,
                message: 'An error occurred while deleting the organization',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Document methods

    // Get all documents for an organization (including jobs, hiring managers, placements)
    async getDocuments(req, res) {
        try {
            const { id } = req.params;
            const orgId = id;

            // 1. Documents uploaded directly to this organization
            const orgDocuments = await this.documentModel.getByEntity('organization', orgId);
            const orgWithSource = orgDocuments.map(doc => ({
                ...doc,
                source_type: 'organization',
                source_label: 'Uploaded directly',
                source_entity_type: 'organization',
                source_entity_id: orgId,
                source_link: null
            }));

            // 2. Documents from jobs, hiring managers, and placements of this organization
            let hmDocuments = [];
            let jobDocuments = [];
            let placementDocuments = [];
            try {
                const hiringManagers = await this.organizationModel.getHiringManagers(orgId);
                const jobs = await this.organizationModel.getJobs(orgId);
                const hmIds = hiringManagers.map(hm => hm.id);
                const jobIds = jobs.map(job => job.id);

                if (hmIds.length > 0) {
                    hmDocuments = await this.documentModel.getByEntities('hiring_manager', hmIds);
                    const hmMap = new Map(hiringManagers.map(hm => [hm.id, hm.full_name || `${hm.first_name || ''} ${hm.last_name || ''}`.trim()]));
                    hmDocuments = hmDocuments.map(doc => ({
                        ...doc,
                        hiring_manager_name: hmMap.get(doc.entity_id),
                        source_type: 'hiring_manager',
                        source_label: `From Hiring Manager (${hmMap.get(doc.entity_id) || '#' + doc.entity_id})`,
                        source_entity_type: 'hiring_manager',
                        source_entity_id: doc.entity_id,
                        source_link: `/dashboard/hiring-managers/view?id=${doc.entity_id}`
                    }));
                }
                if (jobIds.length > 0) {
                    jobDocuments = await this.documentModel.getByEntities('job', jobIds);
                    const jobMap = new Map(jobs.map(j => [j.id, j.job_title || 'Job #' + j.id]));
                    jobDocuments = jobDocuments.map(doc => ({
                        ...doc,
                        source_type: 'job',
                        source_label: `From Job (${jobMap.get(doc.entity_id) || '#' + doc.entity_id})`,
                        source_entity_type: 'job',
                        source_entity_id: doc.entity_id,
                        source_link: `/dashboard/jobs/view?id=${doc.entity_id}`
                    }));
                }

                // 3. Documents from placements (placements whose job belongs to this org)
                const placementIds = await this.organizationModel.getPlacementIdsByOrganizationId(orgId);
                if (placementIds.length > 0) {
                    placementDocuments = await this.documentModel.getByEntities('placement', placementIds);
                    placementDocuments = placementDocuments.map(doc => ({
                        ...doc,
                        source_type: 'placement',
                        source_label: `From Placement #${doc.entity_id}`,
                        source_entity_type: 'placement',
                        source_entity_id: doc.entity_id,
                        source_link: `/dashboard/placements/view?id=${doc.entity_id}`
                    }));
                }
            } catch (err) {
                console.error('Error fetching associated documents:', err);
            }

            // 4. Combine and sort by date
            const allDocuments = [...orgWithSource, ...hmDocuments, ...jobDocuments, ...placementDocuments].sort((a, b) =>
                new Date(b.created_at) - new Date(a.created_at)
            );

            return res.status(200).json({
                success: true,
                count: allDocuments.length,
                documents: allDocuments
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
                entity_type: 'organization',
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

    // Upload document with JSON body (base64) directly to Vercel Blob
    async uploadDocument(req, res) {
        try {
            const { id } = req.params;
            const { document_name, document_type, file } = req.body || {};

            if (!file) {
                return res.status(400).json({
                    success: false,
                    message: 'File is required'
                });
            }

            if (!document_name) {
                return res.status(400).json({
                    success: false,
                    message: 'Document name is required'
                });
            }

            // Support both object shape { name, type, data } and raw base64 string
            const base64Data = typeof file === 'string' ? file : file.data;
            const mimeType = typeof file === 'string' ? (req.body.mime_type || 'application/octet-stream') : file.type;
            const originalName = typeof file === 'string' ? (req.body.file_name || 'document') : file.name;

            if (!base64Data) {
                return res.status(400).json({
                    success: false,
                    message: 'File data is missing'
                });
            }

            // Convert base64 string to Buffer
            const buffer = Buffer.from(base64Data, 'base64');

            // Get the current user's ID
            const userId = req.user.id;

            // Generate unique filename for Vercel Blob
            const timestamp = Date.now();
            const sanitizedName = originalName.replace(/[^a-zA-Z0-9.-]/g, "_");
            const fileName = `organizations/${id}/${timestamp}_${sanitizedName}`;

            // Upload to Vercel Blob
            const blob = await put(fileName, buffer, {
                access: 'public',
                contentType: mimeType
            });

            // Create the document with blob URL
            const document = await this.documentModel.create({
                entity_type: 'organization',
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

    // Get organization summary counts
    async getSummaryCounts(req, res) {
        try {
            const { id } = req.params;
            const client = await this.pool.connect();

            try {
                // Count Client Visits (notes with action "Client Visit" or text containing "client visit")
                const clientVisitsQuery = `
                    SELECT COUNT(*) as count
                    FROM organization_notes
                    WHERE organization_id = $1 
                    AND (
                        action = 'Client Visit' 
                        OR LOWER(COALESCE(action, '')) LIKE '%client visit%'
                        OR LOWER(text) LIKE '%client visit%'
                    )
                `;
                const clientVisitsResult = await client.query(clientVisitsQuery, [id]);
                const clientVisits = parseInt(clientVisitsResult.rows[0]?.count || 0);

                // Count Jobs
                const jobsQuery = `
                    SELECT COUNT(*) as count
                    FROM jobs
                    WHERE organization_id = $1
                `;
                const jobsResult = await client.query(jobsQuery, [id]);
                const jobs = parseInt(jobsResult.rows[0]?.count || 0);

                // Count Submissions (notes with action containing "Submission" or text containing "submission")
                const submissionsQuery = `
                    SELECT COUNT(*) as count
                    FROM organization_notes
                    WHERE organization_id = $1 
                    AND (
                        LOWER(COALESCE(action, '')) LIKE '%submission%'
                        OR LOWER(text) LIKE '%submission%'
                    )
                    AND LOWER(COALESCE(action, '')) NOT LIKE '%client submission%'
                `;
                const submissionsResult = await client.query(submissionsQuery, [id]);
                const submissions = parseInt(submissionsResult.rows[0]?.count || 0);

                // Count Client Submissions (notes with action containing "Client Submission")
                const clientSubmissionsQuery = `
                    SELECT COUNT(*) as count
                    FROM organization_notes
                    WHERE organization_id = $1 
                    AND (
                        LOWER(COALESCE(action, '')) LIKE '%client submission%'
                        OR LOWER(text) LIKE '%client submission%'
                    )
                `;
                const clientSubmissionsResult = await client.query(clientSubmissionsQuery, [id]);
                const clientSubmissions = parseInt(clientSubmissionsResult.rows[0]?.count || 0);

                // Count Interviews (notes with action containing "Interview" or text containing "interview")
                const interviewsQuery = `
                    SELECT COUNT(*) as count
                    FROM organization_notes
                    WHERE organization_id = $1 
                    AND (
                        LOWER(COALESCE(action, '')) LIKE '%interview%'
                        OR LOWER(text) LIKE '%interview%'
                    )
                `;
                const interviewsResult = await client.query(interviewsQuery, [id]);
                const interviews = parseInt(interviewsResult.rows[0]?.count || 0);

                // Count Placements (through jobs)
                const placementsQuery = `
                    SELECT COUNT(DISTINCT p.id) as count
                    FROM placements p
                    INNER JOIN jobs j ON p.job_id = j.id
                    WHERE j.organization_id = $1
                `;
                const placementsResult = await client.query(placementsQuery, [id]);
                const placements = parseInt(placementsResult.rows[0]?.count || 0);

                return res.status(200).json({
                    success: true,
                    counts: {
                        clientVisits,
                        jobs,
                        submissions,
                        clientSubmissions,
                        interviews,
                        placements
                    }
                });
            } finally {
                client.release();
            }
        } catch (error) {
            console.error('Error fetching summary counts:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while fetching summary counts',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }
}

module.exports = OrganizationController;