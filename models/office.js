const VALID_BUILDING_TYPES = ['Office', 'Temporary Location', 'Remote Location'];

class Office {
    constructor(pool) {
        this.pool = pool;
    }

    _validateBuildingType(buildingType) {
        if (buildingType != null && buildingType !== '' && !VALID_BUILDING_TYPES.includes(buildingType)) {
            throw new Error(`building_type must be one of: ${VALID_BUILDING_TYPES.join(', ')}`);
        }
    }

    async initTable() {
        let client;
        try {
            client = await this.pool.connect();
            await client.query(`
                CREATE TABLE IF NOT EXISTS offices (
                    id SERIAL PRIMARY KEY,
                    building_name VARCHAR(255) NOT NULL,
                    address VARCHAR(500) NOT NULL,
                    address2 VARCHAR(500),
                    city VARCHAR(100) NOT NULL,
                    state VARCHAR(100) NOT NULL,
                    zip_code VARCHAR(20) NOT NULL,
                    country VARCHAR(100) DEFAULT 'United States',
                    building_type VARCHAR(100),
                    status BOOLEAN DEFAULT true,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            // Migrate existing invalid building_type values to 'Office'
            const migrate = await client.query(`
                UPDATE offices SET building_type = 'Office'
                WHERE building_type IS NOT NULL AND building_type <> '' AND building_type NOT IN ($1, $2, $3)
            `, VALID_BUILDING_TYPES);
            if (migrate.rowCount > 0) {
                console.log(`✅ Migrated ${migrate.rowCount} office(s) to valid building_type`);
            }
            console.log('✅ Offices table initialized successfully');
            return true;
        } catch (error) {
            console.error('❌ Error initializing offices table:', error.message);
            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    async create(officeData) {
        const {
            buildingName,
            address,
            address2,
            city,
            state,
            zipCode,
            country = 'United States',
            buildingType
        } = officeData;

        this._validateBuildingType(buildingType);

        const client = await this.pool.connect();
        try {
            const query = `
                INSERT INTO offices (building_name, address, address2, city, state, zip_code, country, building_type, status, created_at, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
                RETURNING *
            `;
            const values = [buildingName, address, address2, city, state, zipCode, country, buildingType, true];
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
            const query = 'SELECT * FROM offices WHERE status = true ORDER BY building_name ASC';
            const result = await client.query(query);
            return result.rows;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }

    async update(id, officeData) {
        if (officeData.buildingType !== undefined) {
            this._validateBuildingType(officeData.buildingType);
        }
        const client = await this.pool.connect();
        try {
            const query = `
                UPDATE offices 
                SET building_name = COALESCE($1, building_name),
                    address = COALESCE($2, address),
                    address2 = COALESCE($3, address2),
                    city = COALESCE($4, city),
                    state = COALESCE($5, state),
                    zip_code = COALESCE($6, zip_code),
                    country = COALESCE($7, country),
                    building_type = COALESCE($8, building_type),
                    updated_at = NOW()
                WHERE id = $9
                RETURNING *
            `;
            const values = [
                officeData.buildingName,
                officeData.address,
                officeData.address2,
                officeData.city,
                officeData.state,
                officeData.zipCode,
                officeData.country,
                officeData.buildingType,
                id
            ];
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
            const query = 'UPDATE offices SET status = false, updated_at = NOW() WHERE id = $1';
            await client.query(query, [id]);
            return true;
        } catch (error) {
            throw error;
        } finally {
            client.release();
        }
    }
}

module.exports = Office;