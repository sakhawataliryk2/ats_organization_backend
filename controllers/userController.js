const User = require('../models/user');
const EmailTemplateModel = require('../models/emailTemplateModel');
const { sendMail } = require('../services/emailService');

const WELCOME_EMAIL_TEMPLATE_TYPE = 'WELCOME_EMAIL';
const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

class UserController {
    constructor(pool) {
        this.userModel = new User(pool);
        this.emailTemplateModel = new EmailTemplateModel(pool);
        this.getActiveUsers = this.getActiveUsers.bind(this);
        this.createUser = this.createUser.bind(this);
        this.getAllUsers = this.getAllUsers.bind(this);
        this.updatePassword = this.updatePassword.bind(this);
        this.updateStatus = this.updateStatus.bind(this);
        this.updateRole = this.updateRole.bind(this);
        this.checkDuplicates = this.checkDuplicates.bind(this);
    }

    async sendWelcomeEmail(user) {
        if (!user || !user.email) return;

        const fallbackSubject = 'Welcome to the ATS';
        const context = {
            userName: user.name || '',
            email: user.email || '',
            userType: user.role || '',
            portalUrl: baseUrl,
        };

        let subject = fallbackSubject;
        let html =
            `<div>` +
            `<h2>Welcome</h2>` +
            `<p>Hello ${context.userName || 'there'},</p>` +
            `<p>Your account has been created for our applicant tracking system.</p>` +
            `<p>You can sign in at <a href="${context.portalUrl}">${context.portalUrl}</a> using your work email.</p>` +
            `<p>If you did not expect this account, please contact an administrator.</p>` +
            `</div>`;

        try {
            if (this.emailTemplateModel) {
                const template = await this.emailTemplateModel.getTemplateByType(
                    WELCOME_EMAIL_TEMPLATE_TYPE
                );
                if (template) {
                    const applyPlaceholders = (input) =>
                        typeof input === 'string'
                            ? input.replace(
                                  /{{\s*(userName|email|userType|portalUrl)\s*}}/g,
                                  (match, key) => context[key] || ''
                              )
                            : input;

                    subject = applyPlaceholders(template.subject) || fallbackSubject;
                    html = applyPlaceholders(template.body) || html;
                }
            }
        } catch (error) {
            console.error('Error loading welcome email template:', error);
        }

        try {
            await sendMail({
                to: context.email,
                subject,
                html,
            });
        } catch (error) {
            console.error('Error sending welcome email:', error);
        }
    }

    // GET /api/users/check-duplicates?email=&phone=&excludeId=
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

            const client = await this.userModel.pool.connect();
            try {
                const params = [];
                const conditions = [];

                if (normEmail) {
                    params.push(normEmail);
                    conditions.push("LOWER(TRIM(email)) = $" + params.length);
                }
                if (normPhone) {
                    params.push(normPhone);
                    conditions.push(
                        "REGEXP_REPLACE(COALESCE(phone, ''), '\\\\D', '', 'g') = $" +
                            params.length
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
                    SELECT id, name, email, phone
                    FROM users
                    ${whereClause}
                `;

                const result = await client.query(query, params);
                const rows = result.rows || [];

                const dupEmail = [];
                const dupPhone = [];

                for (const row of rows) {
                    const displayName = row.name || "Unnamed";
                    if (
                        normEmail &&
                        row.email &&
                        row.email.toLowerCase().trim() === normEmail
                    ) {
                        dupEmail.push({ id: row.id, name: displayName });
                    }
                    if (normPhone) {
                        const uPhone = (row.phone || "")
                            .toString()
                            .replace(/\D/g, "")
                            .trim();
                        if (uPhone && uPhone === normPhone) {
                            dupPhone.push({ id: row.id, name: displayName });
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
            console.error("Error checking user duplicates:", error);
            return res.status(500).json({
                success: false,
                message: "An error occurred while checking duplicates",
                error:
                    process.env.NODE_ENV === "production" ? undefined : error.message,
            });
        }
    }

    // Create new user
    async createUser(req, res) {
        try {
            const userData = req.body;
            const user = await this.userModel.create(userData);

            // Fire-and-forget welcome email (do not block or fail creation on email errors)
            this.sendWelcomeEmail({
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
            }).catch((err) => {
                console.error('Async welcome email error:', err);
            });
            
            res.status(201).json({
                success: true,
                message: 'User created successfully',
                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    role: user.role,
                    office_id: user.office_id,
                    team_id: user.team_id,
                    phone: user.phone,
                    phone2: user.phone2,
                    title: user.title,
                    id_number: user.id_number,
                    is_admin: user.is_admin,
                    status: user.status,
                    created_at: user.created_at
                }
            });
        } catch (error) {
            console.error('Error creating user:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to create user',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Add this method to the UserController class
    async updatePassword(req, res) {
        try {
            const { userId } = req.params;
            const { newPassword, confirmPassword } = req.body;

            // Validate inputs
            if (!newPassword || !confirmPassword) {
                return res.status(400).json({
                    success: false,
                    message: 'Both new password and confirmation are required'
                });
            }

            if (newPassword !== confirmPassword) {
                return res.status(400).json({
                    success: false,
                    message: 'Passwords do not match'
                });
            }

            // Validate password strength
            if (newPassword.length < 8) {
                return res.status(400).json({
                    success: false,
                    message: 'Password must be at least 8 characters long'
                });
            }

            const user = await this.userModel.updatePassword(userId, newPassword);

            res.status(200).json({
                success: true,
                message: 'Password updated successfully',
                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    role: user.role
                }
            });
        } catch (error) {
            console.error('Error updating password:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while updating password',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }


    // Update user status (activate/deactivate)
    async updateStatus(req, res) {
        try {
            const { userId } = req.params;
            const { status } = req.body;

            if (typeof status !== 'boolean') {
                return res.status(400).json({
                    success: false,
                    message: 'Status must be a boolean value'
                });
            }

            const updatedUser = await this.userModel.updateStatus(userId, status);

            if (!updatedUser) {
                return res.status(404).json({
                    success: false,
                    message: 'User not found'
                });
            }

            res.status(200).json({
                success: true,
                message: status ? 'User activated successfully' : 'User deactivated successfully',
                user: {
                    id: updatedUser.id,
                    name: updatedUser.name,
                    email: updatedUser.email,
                    role: updatedUser.role,
                    status: updatedUser.status
                }
            });
        } catch (error) {
            console.error('Error updating user status:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while updating user status',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    // Update user role (user type)
    async updateRole(req, res) {
        try {
            const { userId } = req.params;
            const { role } = req.body;

            const validRoles = [
                'developer', 'owner', 'admin', 'administrator',
                'payroll-admin', 'onboarding-admin', 'account-manager-temp',
                'account-manager-perm', 'sales-rep', 'recruiter', 'candidate'
            ];
            if (!role || typeof role !== 'string' || !validRoles.includes(role.trim())) {
                return res.status(400).json({
                    success: false,
                    message: 'Valid role is required'
                });
            }

            const updatedUser = await this.userModel.updateRole(userId, role.trim());

            if (!updatedUser) {
                return res.status(404).json({
                    success: false,
                    message: 'User not found'
                });
            }

            res.status(200).json({
                success: true,
                message: 'User type updated successfully',
                user: {
                    id: updatedUser.id,
                    name: updatedUser.name,
                    email: updatedUser.email,
                    role: updatedUser.role,
                    status: updatedUser.status
                }
            });
        } catch (error) {
            console.error('Error updating user role:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while updating user role',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }



    // Add this method to the UserController class
    async getAllUsers(req, res) {
        try {
            console.log('Fetching all users with details');

            const users = await this.userModel.getAllDetailed();

            res.status(200).json({
                success: true,
                count: users.length,
                users: users.map(user => ({
                    user_id: user.user_id,
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    phone: user.phone,
                    phone2: user.phone2,
                    title: user.title,
                    office_name: user.office_name,
                    team_name: user.team_name,
                    id_number: user.id_number,
                    is_admin: user.is_admin,
                    role: user.role,
                    status: user.status,
                    created_at: user.created_at,
                    updated_at: user.updated_at
                }))
            });
        } catch (error) {
            console.error('Error getting all users:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while retrieving users',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }



    // Password validation helper method (if not already present)
    validatePassword(password) {
        // Check length
        if (password.length < 8) {
            return {
                isValid: false,
                message: 'Password must be at least 8 characters long'
            };
        }

        // Check for lowercase letter
        if (!/[a-z]/.test(password)) {
            return {
                isValid: false,
                message: 'Password must contain at least one lowercase letter'
            };
        }

        // Check for uppercase letter
        if (!/[A-Z]/.test(password)) {
            return {
                isValid: false,
                message: 'Password must contain at least one uppercase letter'
            };
        }

        // Check for number
        if (!/[0-9]/.test(password)) {
            return {
                isValid: false,
                message: 'Password must contain at least one number'
            };
        }

        // Check for special character
        if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
            return {
                isValid: false,
                message: 'Password must contain at least one special character'
            };
        }

        return {
            isValid: true,
            message: 'Password is valid'
        };
    }

    // Get all active users
    async getActiveUsers(req, res) {
        try {
            console.log('Fetching active users for dropdown');

            const users = await this.userModel.getActiveUsers();

            res.status(200).json({
                success: true,
                count: users.length,
                users: users.map(user => ({
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    role: user.role
                }))
            });
        } catch (error) {
            console.error('Error getting active users:', error);
            res.status(500).json({
                success: false,
                message: 'An error occurred while retrieving active users',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }
}

module.exports = UserController;