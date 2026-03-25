class Appointment {
    constructor(pool) {
        this.pool = pool;
    }

    // Initialize the appointments table if it doesn't exist
    async initTable() {
        let client;
        try {
            console.log('Initializing appointments table if needed...');
            client = await this.pool.connect();

            await client.query(`
                CREATE TABLE IF NOT EXISTS appointments (
                    id SERIAL PRIMARY KEY,
                    date DATE NOT NULL,
                    start_time TIME NOT NULL,
                    duration INTEGER NOT NULL,
                    type VARCHAR(50) NOT NULL DEFAULT 'zoom',
                    participant_type VARCHAR(50) NOT NULL CHECK (participant_type IN ('job_seeker', 'hiring_manager', 'organization', 'internal')),
                    participant_id INTEGER NOT NULL,
                    job_id INTEGER REFERENCES jobs(id),
                    owner_id INTEGER NOT NULL REFERENCES users(id),
                    zoom_meeting_id BIGINT,
                    zoom_join_url TEXT,
                    zoom_start_url TEXT,
                    zoom_password VARCHAR(255),
                    status VARCHAR(50) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'live', 'completed')),
                    description TEXT,
                    document_urls TEXT[],
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Add columns if they don't exist (existing deployments)
            await client.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS document_urls TEXT[]`);

            // Create indexes for better query performance
            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date);
                CREATE INDEX IF NOT EXISTS idx_appointments_owner_id ON appointments(owner_id);
                CREATE INDEX IF NOT EXISTS idx_appointments_participant ON appointments(participant_type, participant_id);
                CREATE INDEX IF NOT EXISTS idx_appointments_zoom_meeting_id ON appointments(zoom_meeting_id);
                CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
            `);

            console.log('✅ Appointments table initialized successfully');
            return true;
        } catch (error) {
            console.error('❌ Error initializing appointments table:', error.message);
            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // Create a new appointment
    async create(appointmentData) {
        const {
            date,
            start_time,
            time, // Support both formats
            duration,
            type = 'zoom',
            participant_type,
            participantType, // Support camelCase
            participant_id,
            participantId, // Support camelCase
            job_id,
            jobId, // Support camelCase
            owner_id,
            ownerId, // Support camelCase
            zoom_meeting_id,
            zoomMeetingId, // Support camelCase
            zoom_join_url,
            zoomJoinUrl, // Support camelCase
            zoom_start_url,
            zoomStartUrl, // Support camelCase
            zoom_password,
            zoomPassword, // Support camelCase
            status = 'scheduled',
            description,
            document_urls,
            documentUrls
        } = appointmentData;

        // Normalize field names
        const finalStartTime = start_time || time;
        const finalParticipantType = participant_type || participantType;
        const finalParticipantId = participant_id || participantId;
        const finalJobId = job_id || jobId;
        const finalOwnerId = owner_id || ownerId;
        const finalZoomMeetingId = zoom_meeting_id || zoomMeetingId;
        const finalZoomJoinUrl = zoom_join_url || zoomJoinUrl;
        const finalZoomStartUrl = zoom_start_url || zoomStartUrl;
        const finalZoomPassword = zoom_password || zoomPassword;
        const finalDocumentUrls = document_urls || documentUrls;

        // Normalize time format if needed
        let normalizedTime = finalStartTime;
        if (normalizedTime && typeof normalizedTime === 'string') {
            // If it's a datetime string, extract time part
            if (normalizedTime.includes('T') || normalizedTime.includes(' ')) {
                const parts = normalizedTime.split(/[T ]/);
                if (parts.length > 1) {
                    normalizedTime = parts[1].substring(0, 8); // Extract HH:MM:SS
                }
            }
        }

        let client;
        try {
            client = await this.pool.connect();

            const query = `
                INSERT INTO appointments (
                    date, start_time, duration, type, participant_type, participant_id,
                    job_id, owner_id, zoom_meeting_id, zoom_join_url, zoom_start_url,
                    zoom_password, status, description, document_urls
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                RETURNING *
            `;

            const values = [
                date,
                normalizedTime,
                duration,
                type,
                finalParticipantType,
                finalParticipantId,
                finalJobId || null,
                finalOwnerId,
                finalZoomMeetingId || null,
                finalZoomJoinUrl || null,
                finalZoomStartUrl || null,
                finalZoomPassword || null,
                status,
                description || null,
                Array.isArray(finalDocumentUrls) ? finalDocumentUrls : null
            ];

            const result = await client.query(query, values);
            return result.rows[0];
        } catch (error) {
            console.error('Error creating appointment:', error);
            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // Get all appointments with optional filters
    async getAll(filters = {}) {
        let client;
        try {
            client = await this.pool.connect();

            let query = 'SELECT * FROM appointments WHERE 1=1';
            const values = [];
            let paramIndex = 1;

            if (filters.date) {
                query += ` AND date = $${paramIndex++}`;
                values.push(filters.date);
            }

            if (filters.startDate) {
                query += ` AND date >= $${paramIndex++}`;
                values.push(filters.startDate);
            }

            if (filters.endDate) {
                query += ` AND date <= $${paramIndex++}`;
                values.push(filters.endDate);
            }

            if (Array.isArray(filters.ownerIds) && filters.ownerIds.length > 0) {
                query += ` AND owner_id = ANY($${paramIndex++})`;
                values.push(filters.ownerIds.map((v) => Number(v)).filter((n) => Number.isFinite(n)));
            } else if (filters.ownerId) {
                query += ` AND owner_id = $${paramIndex++}`;
                values.push(filters.ownerId);
            }

            if (filters.status) {
                query += ` AND status = $${paramIndex++}`;
                values.push(filters.status);
            }

            if (filters.participantType && filters.participantId) {
                query += ` AND participant_type = $${paramIndex++} AND participant_id = $${paramIndex++}`;
                values.push(filters.participantType, filters.participantId);
            }

            query += ' ORDER BY date ASC, start_time ASC';

            const result = await client.query(query, values);
            return result.rows;
        } catch (error) {
            console.error('Error getting appointments:', error);
            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // Get appointment by ID
    async getById(id) {
        let client;
        try {
            client = await this.pool.connect();

            const query = 'SELECT * FROM appointments WHERE id = $1';
            const result = await client.query(query, [id]);

            if (result.rows.length === 0) {
                return null;
            }

            return result.rows[0];
        } catch (error) {
            console.error('Error getting appointment by ID:', error);
            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // Get appointment by Zoom meeting ID
    async getByZoomMeetingId(zoomMeetingId) {
        let client;
        try {
            client = await this.pool.connect();

            const query = 'SELECT * FROM appointments WHERE zoom_meeting_id = $1';
            const result = await client.query(query, [zoomMeetingId]);

            if (result.rows.length === 0) {
                return null;
            }

            return result.rows[0];
        } catch (error) {
            console.error('Error getting appointment by Zoom meeting ID:', error);
            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // Update appointment
    async update(id, appointmentData) {
        const {
            date,
            start_time,
            time,
            duration,
            type,
            participant_type,
            participantType,
            participant_id,
            participantId,
            job_id,
            jobId,
            zoom_meeting_id,
            zoomMeetingId,
            zoom_join_url,
            zoomJoinUrl,
            zoom_start_url,
            zoomStartUrl,
            zoom_password,
            zoomPassword,
            status,
            description
        } = appointmentData;

        let client;
        try {
            client = await this.pool.connect();

            // Build dynamic update query
            const updates = [];
            const values = [];
            let paramIndex = 1;

            if (date !== undefined) {
                updates.push(`date = $${paramIndex++}`);
                values.push(date);
            }

            if (start_time !== undefined || time !== undefined) {
                let normalizedTime = start_time || time;
                if (normalizedTime && typeof normalizedTime === 'string') {
                    if (normalizedTime.includes('T') || normalizedTime.includes(' ')) {
                        const parts = normalizedTime.split(/[T ]/);
                        if (parts.length > 1) {
                            normalizedTime = parts[1].substring(0, 8);
                        }
                    }
                }
                updates.push(`start_time = $${paramIndex++}`);
                values.push(normalizedTime);
            }

            if (duration !== undefined) {
                updates.push(`duration = $${paramIndex++}`);
                values.push(duration);
            }

            if (type !== undefined) {
                updates.push(`type = $${paramIndex++}`);
                values.push(type);
            }

            if (participant_type !== undefined || participantType !== undefined) {
                updates.push(`participant_type = $${paramIndex++}`);
                values.push(participant_type || participantType);
            }

            if (participant_id !== undefined || participantId !== undefined) {
                updates.push(`participant_id = $${paramIndex++}`);
                values.push(participant_id || participantId);
            }

            if (job_id !== undefined || jobId !== undefined) {
                updates.push(`job_id = $${paramIndex++}`);
                values.push(job_id || jobId || null);
            }

            if (zoom_meeting_id !== undefined || zoomMeetingId !== undefined) {
                updates.push(`zoom_meeting_id = $${paramIndex++}`);
                values.push(zoom_meeting_id || zoomMeetingId || null);
            }

            if (zoom_join_url !== undefined || zoomJoinUrl !== undefined) {
                updates.push(`zoom_join_url = $${paramIndex++}`);
                values.push(zoom_join_url || zoomJoinUrl || null);
            }

            if (zoom_start_url !== undefined || zoomStartUrl !== undefined) {
                updates.push(`zoom_start_url = $${paramIndex++}`);
                values.push(zoom_start_url || zoomStartUrl || null);
            }

            if (zoom_password !== undefined || zoomPassword !== undefined) {
                updates.push(`zoom_password = $${paramIndex++}`);
                values.push(zoom_password || zoomPassword || null);
            }

            if (status !== undefined) {
                updates.push(`status = $${paramIndex++}`);
                values.push(status);
            }

            if (description !== undefined) {
                updates.push(`description = $${paramIndex++}`);
                values.push(description);
            }

            if (updates.length === 0) {
                return await this.getById(id);
            }

            updates.push(`updated_at = CURRENT_TIMESTAMP`);
            values.push(id);

            const query = `
                UPDATE appointments 
                SET ${updates.join(', ')}
                WHERE id = $${paramIndex}
                RETURNING *
            `;

            const result = await client.query(query, values);

            if (result.rows.length === 0) {
                return null;
            }

            return result.rows[0];
        } catch (error) {
            console.error('Error updating appointment:', error);
            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // Delete appointment
    async delete(id) {
        let client;
        try {
            client = await this.pool.connect();

            const query = 'DELETE FROM appointments WHERE id = $1 RETURNING *';
            const result = await client.query(query, [id]);

            if (result.rows.length === 0) {
                return null;
            }

            return result.rows[0];
        } catch (error) {
            console.error('Error deleting appointment:', error);
            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // Get participant name based on participant_type and participant_id
    async getParticipantName(participantType, participantId) {
        let client;
        try {
            client = await this.pool.connect();
            let query;
            let name = '';

            switch (participantType) {
                case 'job_seeker':
                    query = `
                        SELECT COALESCE(
                            CONCAT_WS(' ', first_name, last_name),
                            first_name,
                            last_name,
                            email,
                            'Job Seeker'
                        ) as name
                        FROM job_seekers
                        WHERE id = $1
                    `;
                    break;
                case 'hiring_manager':
                    query = `
                        SELECT COALESCE(
                            CONCAT_WS(' ', first_name, last_name),
                            first_name,
                            last_name,
                            email,
                            'Hiring Manager'
                        ) as name
                        FROM hiring_managers
                        WHERE id = $1
                    `;
                    break;
                case 'organization':
                    query = `
                        SELECT COALESCE(name, 'Organization') as name
                        FROM organizations
                        WHERE id = $1
                    `;
                    break;
                case 'internal':
                    query = `
                        SELECT COALESCE(name, email, 'Internal User') as name
                        FROM users
                        WHERE id = $1
                    `;
                    break;
                default:
                    return 'Unknown Participant';
            }

            const result = await client.query(query, [participantId]);
            if (result.rows.length > 0) {
                name = result.rows[0].name;
            }

            return name;
        } catch (error) {
            console.error('Error getting participant name:', error);
            return 'Unknown Participant';
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // Get job title if job_id exists
    async getJobTitle(jobId) {
        if (!jobId) return null;

        let client;
        try {
            client = await this.pool.connect();

            const query = 'SELECT job_title FROM jobs WHERE id = $1';
            const result = await client.query(query, [jobId]);

            if (result.rows.length > 0) {
                return result.rows[0].job_title;
            }

            return null;
        } catch (error) {
            console.error('Error getting job title:', error);
            return null;
        } finally {
            if (client) {
                client.release();
            }
        }
    }
}

module.exports = Appointment;
