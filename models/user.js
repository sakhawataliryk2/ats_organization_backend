const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

class User {
    constructor(pool) {
        this.pool = pool;
    }

    // Initialize the users table and user_id counter table
    async initTable() {
        let client;
        try {
            console.log('Initializing users table if needed...');
            client = await this.pool.connect();

            await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          email VARCHAR(255) UNIQUE NOT NULL,
          password VARCHAR(255) NOT NULL,
          role VARCHAR(50) NOT NULL DEFAULT 'recruiter',
          office_id INTEGER REFERENCES offices(id),
          team_id INTEGER REFERENCES teams(id),
          phone VARCHAR(20),
          phone2 VARCHAR(20),
          title VARCHAR(100),
          id_number VARCHAR(50),
          user_id VARCHAR(20) UNIQUE,
          is_admin BOOLEAN DEFAULT false,
          token VARCHAR(500),
          otp_code VARCHAR(255),
          otp_expires_at TIMESTAMP,
          status BOOLEAN DEFAULT true,
          must_change_password BOOLEAN DEFAULT false,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
            // Ensure role constraint allows all user types (drop old if exists, add expanded list)
            await client.query(`
        ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
      `);
            await client.query(`
        ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN (
          'candidate', 'recruiter', 'developer', 'admin', 'owner',
          'administrator', 'payroll-admin', 'onboarding-admin',
          'account-manager-temp', 'account-manager-perm', 'sales-rep'
        ));
      `);
            // Add user_id column if table already existed without it
            await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='user_id') THEN
            ALTER TABLE users ADD COLUMN user_id VARCHAR(20) UNIQUE;
          END IF;
        END $$
      `);
            await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='otp_code') THEN
            ALTER TABLE users ADD COLUMN otp_code VARCHAR(255);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='otp_expires_at') THEN
            ALTER TABLE users ADD COLUMN otp_expires_at TIMESTAMP;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='must_change_password') THEN
            ALTER TABLE users ADD COLUMN must_change_password BOOLEAN DEFAULT false;
          END IF;
        END $$
      `);
            await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_user_id ON users(user_id) WHERE user_id IS NOT NULL;
      `);
            // Counter table for USR-YYYY-XXXX generation
            await client.query(`
        CREATE TABLE IF NOT EXISTS user_id_counters (
          year INT PRIMARY KEY,
          counter INT NOT NULL DEFAULT 0
        )
      `);
            // Backfill user_id for existing users that don't have one
            const needBackfill = await client.query(
                'SELECT id, created_at FROM users WHERE user_id IS NULL ORDER BY id ASC'
            );
            for (const row of needBackfill.rows) {
                const year = new Date(row.created_at).getFullYear();
                const next = await this._getNextUserIdForYear(client, year);
                await client.query(
                    'UPDATE users SET user_id = $1 WHERE id = $2',
                    [next, row.id]
                );
            }
            console.log('✅ Users table initialized successfully');
            return true;
        } catch (error) {
            console.error('❌ Error initializing users table:', error.message);
            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // Atomically get next user_id for year (USR-YYYY-XXXX). Caller must pass client from active transaction.
    async _getNextUserIdForYear(client, year) {
        await client.query(
            'INSERT INTO user_id_counters (year, counter) VALUES ($1, 0) ON CONFLICT (year) DO NOTHING',
            [year]
        );
        const upd = await client.query(
            `UPDATE user_id_counters SET counter = counter + 1 WHERE year = $1 RETURNING counter`,
            [year]
        );
        const counter = upd.rows[0].counter;
        return `USR-${year}-${String(counter).padStart(4, '0')}`;
    }

    // Create a new user. password is required (plain) or use passwordAlreadyHashed with pre-hashed for auto-gen.
    async create(userData) {
        const { name, email, password, userType, officeId, teamId, phone, phone2, title, idNumber, isAdmin, passwordAlreadyHashed, mustChangePassword } = userData;
        const client = await this.pool.connect();

        try {
            // Check if user with this email already exists
            const checkUserQuery = 'SELECT * FROM users WHERE email = $1';
            const checkResult = await client.query(checkUserQuery, [email]);

            if (checkResult.rows.length > 0) {
                throw new Error('User with this email already exists');
            }

            // Begin transaction first so we can generate user_id atomically
            await client.query('BEGIN');

            const year = new Date().getFullYear();
            const userId = await this._getNextUserIdForYear(client, year);

            const saltRounds = 10;
            let hashedPassword;
            if (passwordAlreadyHashed && password) {
                hashedPassword = password;
            } else if (password != null && password !== '') {
                hashedPassword = await bcrypt.hash(password, saltRounds);
            } else {
                await client.query('ROLLBACK');
                throw new Error('Password is required');
            }

            // Resolve role from userType; set is_admin for elevated roles
            const role = (userType && String(userType).trim()) || 'recruiter';
            const elevatedRoles = ['admin', 'owner', 'developer', 'administrator'];
            const isAdminFlag = isAdmin === true || elevatedRoles.includes(role.toLowerCase());

            // Generate a JWT token
            const token = jwt.sign(
                { email, userType: role },
                process.env.JWT_SECRET || 'default_secret_key',
                { expiresIn: '7d' }
            );

            // Convert empty strings to null for optional fields
            const cleanPhone = phone && String(phone).trim() !== '' ? String(phone).trim() : null;
            const cleanPhone2 = phone2 && String(phone2).trim() !== '' ? String(phone2).trim() : null;
            const cleanTitle = title && String(title).trim() !== '' ? String(title).trim() : null;
            const cleanIdNumber = idNumber && String(idNumber).trim() !== '' ? String(idNumber).trim() : null;
            const cleanOfficeId = officeId && String(officeId).trim() !== '' ? String(officeId).trim() : null;
            const cleanTeamId = teamId && String(teamId).trim() !== '' ? String(teamId).trim() : null;

            // Insert user into database (user_id generated atomically above)
            const insertUserQuery = `
        INSERT INTO users (name, email, password, role, office_id, team_id, phone, phone2, title, id_number, user_id, is_admin, token, status, must_change_password, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())
        RETURNING id, name, email, role, office_id, team_id, phone, phone2, title, id_number, user_id, is_admin, token, status, must_change_password, created_at
      `;

            const values = [
                name,
                email,
                hashedPassword,
                role,
                cleanOfficeId,
                cleanTeamId,
                cleanPhone,
                cleanPhone2,
                cleanTitle,
                cleanIdNumber,
                userId,
                isAdminFlag,
                token,
                true,
                mustChangePassword === true
            ];
            const result = await client.query(insertUserQuery, values);

            // If user is being added to a team, also add them to team_members table
            if (cleanTeamId) {
                try {
                    await client.query(
                        'INSERT INTO team_members (team_id, user_id, role, added_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT DO NOTHING',
                        [cleanTeamId, result.rows[0].id, 'member']
                    );
                } catch (teamMemberError) {
                    console.error('Error adding user to team_members:', teamMemberError);
                    // Don't fail the entire transaction if team_members insert fails
                    // This could happen if the table doesn't exist or has constraints
                }
            }

            // Commit transaction
            await client.query('COMMIT');

            return {
                id: result.rows[0].id,
                name: result.rows[0].name,
                email: result.rows[0].email,
                role: result.rows[0].role,
                officeId: result.rows[0].office_id,
                teamId: result.rows[0].team_id,
                phone: result.rows[0].phone,
                phone2: result.rows[0].phone2,
                title: result.rows[0].title,
                idNumber: result.rows[0].id_number,
                userId: result.rows[0].user_id,
                isAdmin: result.rows[0].is_admin,
                token: result.rows[0].token,
                status: result.rows[0].status,
                mustChangePassword: result.rows[0].must_change_password,
                createdAt: result.rows[0].created_at
            };
        } catch (error) {
            // Rollback transaction in case of error
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('Error during rollback:', rollbackError);
            }
            console.error('Error creating user:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    // Find user by email (case-insensitive, trim-aware)
    async findByEmail(email) {
        const client = await this.pool.connect();
        try {
            const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
            if (!normalizedEmail) return null;
            // Match email case-insensitively so "Gdourq@..." and "gdourq@..." both work
            try {
                const query = `
                    SELECT u.*, o.building_name as office_name, t.name as team_name
                    FROM users u
                    LEFT JOIN offices o ON u.office_id = o.id
                    LEFT JOIN teams t ON u.team_id = t.id
                    WHERE LOWER(TRIM(u.email)) = $1
                `;
                const result = await client.query(query, [normalizedEmail]);
                return result.rows[0] || null;
            } catch (joinError) {
                // If JOINs fail (tables might not exist), fall back to simple query
                console.warn('JOIN query failed, falling back to simple query:', joinError.message);
                const simpleQuery = 'SELECT * FROM users WHERE LOWER(TRIM(email)) = $1';
                const result = await client.query(simpleQuery, [normalizedEmail]);
                return result.rows[0] || null;
            }
        } catch (error) {
            console.error('Error in findByEmail:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    // Find user by token
    async findByToken(token) {
        const client = await this.pool.connect();
        try {
            const query = `
                SELECT u.*, o.building_name as office_name, t.name as team_name
                FROM users u
                LEFT JOIN offices o ON u.office_id = o.id
                LEFT JOIN teams t ON u.team_id = t.id
                WHERE u.token = $1
            `;
            const result = await client.query(query, [token]);
            return result.rows[0] || null;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Find user by ID
    async findById(id) {
        const client = await this.pool.connect();
        try {
            const query = `
                SELECT u.*, o.building_name as office_name, t.name as team_name
                FROM users u
                LEFT JOIN offices o ON u.office_id = o.id
                LEFT JOIN teams t ON u.team_id = t.id
                WHERE u.id = $1
            `;
            const result = await client.query(query, [id]);
            return result.rows[0] || null;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Update user token
    async updateToken(userId, token) {
        const client = await this.pool.connect();
        try {
            const query = 'UPDATE users SET token = $1, updated_at = NOW() WHERE id = $2 RETURNING *';
            const result = await client.query(query, [token, userId]);
            return result.rows[0];
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Set OTP code and expiration for 2FA
    async setOtp(userId, otpCode, expiresAt) {
        const client = await this.pool.connect();
        try {
            const query = `
                UPDATE users
                SET otp_code = $1,
                    otp_expires_at = $2,
                    updated_at = NOW()
                WHERE id = $3
                RETURNING id, email, otp_expires_at
            `;
            const result = await client.query(query, [otpCode, expiresAt, userId]);
            return result.rows[0] || null;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Clear OTP data after successful verification or expiry
    async clearOtp(userId) {
        const client = await this.pool.connect();
        try {
            const query = `
                UPDATE users
                SET otp_code = NULL,
                    otp_expires_at = NULL,
                    updated_at = NOW()
                WHERE id = $1
                RETURNING id
            `;
            const result = await client.query(query, [userId]);
            return result.rows[0] || null;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Update user status
    async updateStatus(userId, status) {
        const client = await this.pool.connect();
        try {
            const query = 'UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *';
            const result = await client.query(query, [status, userId]);
            return result.rows[0];
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Update user role (user type)
    async updateRole(userId, role) {
        const client = await this.pool.connect();
        try {
            const query = 'UPDATE users SET role = $1, is_admin = $2, updated_at = NOW() WHERE id = $3 RETURNING *';
            const isAdmin = role === 'admin' || role === 'owner' || role === 'developer' || role === 'administrator';
            const result = await client.query(query, [role, isAdmin, userId]);
            return result.rows[0];
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Get all active users with office and team info
    async getActiveUsers() {
        const client = await this.pool.connect();
        try {
            const query = `
                SELECT u.id, u.user_id, u.name, u.email, u.role, u.phone, u.phone2, u.title, 
                       u.id_number, u.is_admin, u.office_id, u.team_id,
                       o.building_name as office_name, t.name as team_name
                FROM users u 
                LEFT JOIN offices o ON u.office_id = o.id
                LEFT JOIN teams t ON u.team_id = t.id
                WHERE u.status = true 
                ORDER BY u.name ASC
            `;
            const result = await client.query(query);
            return result.rows;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Get users by IDs (for distribution list etc.) - returns id, name, email
    async getUsersByIds(ids) {
        if (!ids || !Array.isArray(ids)) return [];
        const cleanIds = ids.map((id) => parseInt(String(id), 10)).filter((id) => !isNaN(id) && id > 0);
        if (!cleanIds.length) return [];
        const client = await this.pool.connect();
        try {
            const placeholders = cleanIds.map((_, i) => `$${i + 1}`).join(", ");
            const query = `
                SELECT id, name, email
                FROM users
                WHERE id IN (${placeholders}) AND status = true
            `;
            const result = await client.query(query, cleanIds);
            return result.rows;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Get users by team
    async getUsersByTeam(teamId) {
        const client = await this.pool.connect();
        try {
            const query = `
                SELECT u.id, u.name, u.email, u.role, u.phone, u.title
                FROM users u
                WHERE u.team_id = $1 AND u.status = true
                ORDER BY u.name ASC
            `;
            const result = await client.query(query, [teamId]);
            return result.rows;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Get users by office
    async getUsersByOffice(officeId) {
        const client = await this.pool.connect();
        try {
            const query = `
                SELECT u.id, u.name, u.email, u.role, u.phone, u.title, t.name as team_name
                FROM users u
                LEFT JOIN teams t ON u.team_id = t.id
                WHERE u.office_id = $1 AND u.status = true
                ORDER BY u.name ASC
            `;
            const result = await client.query(query, [officeId]);
            return result.rows;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Update user's office and team
    async updateOfficeAndTeam(userId, officeId, teamId) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // Update user's office and team
            const updateUserQuery = `
                UPDATE users 
                SET office_id = $1, team_id = $2, updated_at = NOW() 
                WHERE id = $3 
                RETURNING *
            `;
            const result = await client.query(updateUserQuery, [officeId, teamId, userId]);

            // Update team_members table
            if (teamId) {
                // Remove from old team if any
                await client.query('DELETE FROM team_members WHERE user_id = $1', [userId]);

                // Add to new team
                await client.query(
                    'INSERT INTO team_members (team_id, user_id, role, added_at) VALUES ($1, $2, $3, NOW())',
                    [teamId, userId, 'member']
                );
            }

            await client.query('COMMIT');
            return result.rows[0];
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    // Update user profile
    async updateProfile(userId, userData) {
        const { name, email, phone, phone2, title, idNumber, officeId, teamId } = userData;
        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            // Check if email is already taken by another user
            if (email) {
                const checkEmailQuery = 'SELECT id FROM users WHERE email = $1 AND id != $2';
                const emailCheck = await client.query(checkEmailQuery, [email, userId]);
                if (emailCheck.rows.length > 0) {
                    throw new Error('Email address is already in use by another user');
                }
            }

            // Update user information
            const updateQuery = `
                UPDATE users 
                SET name = COALESCE($1, name),
                    email = COALESCE($2, email),
                    phone = COALESCE($3, phone),
                    phone2 = COALESCE($4, phone2),
                    title = COALESCE($5, title),
                    id_number = COALESCE($6, id_number),
                    office_id = COALESCE($7, office_id),
                    team_id = COALESCE($8, team_id),
                    updated_at = NOW()
                WHERE id = $9
                RETURNING *
            `;

            const values = [name, email, phone, phone2, title, idNumber, officeId, teamId, userId];
            const result = await client.query(updateQuery, values);

            // Update team_members table if team changed
            if (teamId) {
                // Remove from old team
                await client.query('DELETE FROM team_members WHERE user_id = $1', [userId]);

                // Add to new team
                await client.query(
                    'INSERT INTO team_members (team_id, user_id, role, added_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT DO NOTHING',
                    [teamId, userId, 'member']
                );
            }

            await client.query('COMMIT');
            return result.rows[0];
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    // Add this method to the User class
    async updatePassword(userId, newPassword) {
        const client = await this.pool.connect();
        try {
            // Hash the new password
            const saltRounds = 10;
            const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

            const query = `
            UPDATE users 
            SET password = $1, must_change_password = false, updated_at = NOW() 
            WHERE id = $2 
            RETURNING id, name, email, role, must_change_password
        `;
            const result = await client.query(query, [hashedPassword, userId]);
            return result.rows[0];
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Get user statistics
    async getUserStats() {
        const client = await this.pool.connect();
        try {
            const query = `
                SELECT 
                    COUNT(*) as total_users,
                    COUNT(CASE WHEN status = true THEN 1 END) as active_users,
                    COUNT(CASE WHEN status = false THEN 1 END) as inactive_users,
                    COUNT(CASE WHEN is_admin = true THEN 1 END) as admin_users,
                    COUNT(CASE WHEN role = 'recruiter' THEN 1 END) as recruiters,
                    COUNT(CASE WHEN role = 'candidate' THEN 1 END) as candidates,
                    COUNT(CASE WHEN role = 'admin' THEN 1 END) as admins,
                    COUNT(CASE WHEN role = 'owner' THEN 1 END) as owners,
                    COUNT(CASE WHEN role = 'developer' THEN 1 END) as developers
                FROM users
            `;
            const result = await client.query(query);
            return result.rows[0];
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Delete user (soft delete by setting status to false)
    async delete(userId) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // Remove from team_members
            await client.query('DELETE FROM team_members WHERE user_id = $1', [userId]);

            // Soft delete user
            const query = 'UPDATE users SET status = false, updated_at = NOW() WHERE id = $1 RETURNING *';
            const result = await client.query(query, [userId]);

            await client.query('COMMIT');
            return result.rows[0];
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    // Hard delete user (permanent deletion)
    async hardDelete(userId) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // Remove from team_members first (foreign key constraint)
            await client.query('DELETE FROM team_members WHERE user_id = $1', [userId]);

            // Delete user permanently
            const query = 'DELETE FROM users WHERE id = $1 RETURNING *';
            const result = await client.query(query, [userId]);

            await client.query('COMMIT');
            return result.rows[0];
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    // Search users
    async search(searchTerm, filters = {}) {
        const client = await this.pool.connect();
        try {
            let query = `
                SELECT u.id, u.name, u.email, u.role, u.phone, u.phone2, u.title, 
                       u.id_number, u.is_admin, u.status, u.office_id, u.team_id,
                       o.building_name as office_name, t.name as team_name
                FROM users u 
                LEFT JOIN offices o ON u.office_id = o.id
                LEFT JOIN teams t ON u.team_id = t.id
                WHERE 1=1
            `;

            const params = [];
            let paramIndex = 1;

            // Add search term filter
            if (searchTerm) {
                query += ` AND (
                    u.name ILIKE $${paramIndex} OR 
                    u.email ILIKE $${paramIndex} OR 
                    u.phone ILIKE $${paramIndex} OR 
                    u.title ILIKE $${paramIndex} OR
                    o.building_name ILIKE $${paramIndex} OR
                    t.name ILIKE $${paramIndex}
                )`;
                params.push(`%${searchTerm}%`);
                paramIndex++;
            }

            // Add filters
            if (filters.role) {
                query += ` AND u.role = $${paramIndex}`;
                params.push(filters.role);
                paramIndex++;
            }

            if (filters.officeId) {
                query += ` AND u.office_id = $${paramIndex}`;
                params.push(filters.officeId);
                paramIndex++;
            }

            if (filters.teamId) {
                query += ` AND u.team_id = $${paramIndex}`;
                params.push(filters.teamId);
                paramIndex++;
            }

            if (filters.status !== undefined) {
                query += ` AND u.status = $${paramIndex}`;
                params.push(filters.status);
                paramIndex++;
            }

            if (filters.isAdmin !== undefined) {
                query += ` AND u.is_admin = $${paramIndex}`;
                params.push(filters.isAdmin);
                paramIndex++;
            }

            query += ' ORDER BY u.name ASC';

            // Add pagination if specified
            if (filters.limit) {
                query += ` LIMIT $${paramIndex}`;
                params.push(filters.limit);
                paramIndex++;
            }

            if (filters.offset) {
                query += ` OFFSET $${paramIndex}`;
                params.push(filters.offset);
                paramIndex++;
            }

            const result = await client.query(query, params);
            return result.rows;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    // Get all users with detailed information (for admin purposes)
    async getAllDetailed(filters = {}) {
        const client = await this.pool.connect();
        try {
            let query = `
                SELECT u.id, u.user_id, u.name, u.email, u.role, u.phone, u.phone2, u.title, 
                       u.id_number, u.is_admin, u.status, u.office_id, u.team_id,
                       u.created_at, u.updated_at,
                       o.building_name as office_name, 
                       t.name as team_name,
                       COUNT(tm.user_id) as team_count
                FROM users u 
                LEFT JOIN offices o ON u.office_id = o.id
                LEFT JOIN teams t ON u.team_id = t.id
                LEFT JOIN team_members tm ON u.id = tm.user_id
                WHERE 1=1
            `;

            const params = [];
            let paramIndex = 1;

            // Add status filter
            if (filters.status !== undefined) {
                query += ` AND u.status = $${paramIndex}`;
                params.push(filters.status);
                paramIndex++;
            }

            query += ` GROUP BY u.id, u.user_id, o.building_name, t.name ORDER BY u.name ASC`;

            const result = await client.query(query, params);
            return result.rows;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }
}

module.exports = User;