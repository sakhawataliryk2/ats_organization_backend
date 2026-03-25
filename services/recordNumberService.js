/**
 * Reusable business record number service.
 * - All operations use Primary Key (id). record_number is for display only.
 * - Allocation is concurrency-safe (use inside transaction; DB uses FOR UPDATE).
 * - Release only on HARD delete (not soft/archive).
 */

const fs = require('fs');
const path = require('path');

const ALLOWED_MODULES = ['task', 'job', 'organization', 'hiring_manager', 'lead', 'placement', 'job_seeker'];

function validateModule(moduleType) {
    if (!ALLOWED_MODULES.includes(moduleType)) {
        throw new Error(`Invalid module_type for record number: ${moduleType}. Allowed: ${ALLOWED_MODULES.join(', ')}`);
    }
}

/**
 * Allocate next record_number for a module. Call within an existing transaction (same client).
 * Uses reusable_numbers first (smallest), then sequence. Concurrency-safe via FOR UPDATE in DB.
 *
 * @param {object} client - pg client from pool.connect() (transaction must be started by caller)
 * @param {string} moduleType - 'task' | 'job' | 'organization'
 * @returns {Promise<number>} allocated record_number
 */
async function allocateRecordNumber(client, moduleType) {
    validateModule(moduleType);
    const result = await client.query('SELECT allocate_record_number($1) AS num', [moduleType]);
    const num = result.rows[0]?.num;
    if (num == null || typeof num !== 'number') {
        throw new Error(`allocate_record_number returned invalid value for module ${moduleType}`);
    }
    return num;
}

/**
 * Release a record_number back to the pool (for reuse after HARD delete).
 * Call within the same transaction as the DELETE, before deleting the row.
 *
 * @param {object} client - pg client (same transaction as DELETE)
 * @param {string} moduleType - 'task' | 'job' | 'organization'
 * @param {number} number - the record_number being released
 */
async function releaseRecordNumber(client, moduleType, number) {
    validateModule(moduleType);
    const num = parseInt(number, 10);
    if (isNaN(num) || num < 1) return;
    await client.query(
        'INSERT INTO reusable_numbers (module_type, number) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [moduleType, num]
    );
}

/**
 * Get display string for a record: prefix + '-' + record_number (e.g. T-15, J-4).
 * Can be used when building API responses. Prefixes are in modules table; fallback map below.
 */
const PREFIX_MAP = {
    task: 'T',
    job: 'J',
    organization: 'O',
    hiring_manager: 'HM',
    lead: 'L',
    placement: 'P',
    job_seeker: 'JS',
};

function formatDisplayRecordNumber(moduleType, recordNumber) {
    if (recordNumber == null) return '';
    const prefix = PREFIX_MAP[moduleType] || moduleType;
    return `${prefix}-${recordNumber}`;
}

/**
 * Run reusable_record_numbers migration if not already applied.
 * Call once during init (e.g. from Task or Organization initTable). Uses client for same-connection check.
 *
 * @param {object} client - pg client
 */
async function runMigrationIfNeeded(client) {
    const sqlPath = path.join(__dirname, '..', 'migrations', 'reusable_record_numbers.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await client.query(sql);
}

module.exports = {
    allocateRecordNumber,
    releaseRecordNumber,
    formatDisplayRecordNumber,
    runMigrationIfNeeded,
    ALLOWED_MODULES,
};
