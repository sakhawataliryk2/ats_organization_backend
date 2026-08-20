class Team {
    constructor(pool) {
        this.pool = pool;
    }

    async initTable() {
        let client;
        try {
            client = await this.pool.connect();

            // Create teams table
            await client.query(`
                CREATE TABLE IF NOT EXISTS teams (
                    id SERIAL PRIMARY KEY,
                    name VARCHAR(255) NOT NULL,
                    office_id INTEGER REFERENCES offices(id),
                    description TEXT,
                    status BOOLEAN DEFAULT true,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Create team_members table
            await client.query(`
                CREATE TABLE IF NOT EXISTS team_members (
                    id SERIAL PRIMARY KEY,
                    team_id INTEGER REFERENCES teams(id),
                    user_id INTEGER REFERENCES users(id),
                    role VARCHAR(50) DEFAULT 'member',
                    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(team_id, user_id)
                )
            `);

            console.log('✅ Teams tables initialized successfully');
            return true;
        } catch (error) {
            console.error('❌ Error initializing teams tables:', error.message);
            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    async create(teamData) {
        const { name, officeId, description } = teamData;
        const client = await this.pool.connect();

        try {
            const query = `
                INSERT INTO teams (name, office_id, description, status, created_at, updated_at)
                VALUES ($1, $2, $3, $4, NOW(), NOW())
                RETURNING *
            `;
            const values = [name, officeId, description, true];
            const result = await client.query(query, values);
            return result.rows[0];
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    async getAll() {
        const client = await this.pool.connect();
        try {
            const query = `
                SELECT t.*, o.building_name as office_name
                FROM teams t
                LEFT JOIN offices o ON t.office_id = o.id
                WHERE t.status = true
                ORDER BY t.name ASC
            `;
            const result = await client.query(query);
            return result.rows;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    async getMembers(teamId) {
        const client = await this.pool.connect();
        try {
            const query = `
                SELECT tm.*, u.name as user_name, u.email as user_email
                FROM team_members tm
                JOIN users u ON tm.user_id = u.id
                WHERE tm.team_id = $1 AND u.status = true
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

    async addMember(teamId, memberData) {
        const { userId, userName, role = 'member' } = memberData;
        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            let actualUserId = userId;

            // If userName is provided but no userId, create a new user or find existing one
            if (userName && !userId) {
                // Check if user already exists
                const existingUserQuery = 'SELECT id FROM users WHERE name = $1';
                const existingUser = await client.query(existingUserQuery, [userName]);

                if (existingUser.rows.length > 0) {
                    actualUserId = existingUser.rows[0].id;
                } else {
                    // Create a temporary user entry (you might want to handle this differently)
                    const createUserQuery = `
                        INSERT INTO users (name, email, password, role, status, created_at, updated_at)
                        VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
                        RETURNING id
                    `;
                    const tempEmail = `${userName.toLowerCase().replace(' ', '.')}@temp.com`;
                    const tempPassword = 'temp_password_123'; // Should be hashed
                    const newUser = await client.query(createUserQuery, [userName, tempEmail, tempPassword, 'candidate', false]);
                    actualUserId = newUser.rows[0].id;
                }
            }

            // Add to team
            const query = `
               INSERT INTO team_members (team_id, user_id, role, added_at)
               VALUES ($1, $2, $3, NOW())
               ON CONFLICT (team_id, user_id) DO UPDATE SET role = $3
               RETURNING *
           `;
            const result = await client.query(query, [teamId, actualUserId, role]);

            await client.query('COMMIT');
            return result.rows[0];
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async removeMember(teamId, userId) {
        const client = await this.pool.connect();
        try {
            const query = 'DELETE FROM team_members WHERE team_id = $1 AND user_id = $2';
            await client.query(query, [teamId, userId]);
            return true;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    async update(id, teamData) {
        const client = await this.pool.connect();
        try {
            const query = `
               UPDATE teams 
               SET name = COALESCE($1, name),
                   office_id = COALESCE($2, office_id),
                   description = COALESCE($3, description),
                   updated_at = NOW()
               WHERE id = $4
               RETURNING *
           `;
            const values = [teamData.name, teamData.officeId, teamData.description, id];
            const result = await client.query(query, values);
            return result.rows[0];
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    async delete(id) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // Remove all team members first
            await client.query('DELETE FROM team_members WHERE team_id = $1', [id]);

            // Soft delete the team
            await client.query('UPDATE teams SET status = false, updated_at = NOW() WHERE id = $1', [id]);

            await client.query('COMMIT');
            return true;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
}

module.exports = Team;