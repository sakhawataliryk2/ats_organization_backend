/**
 * Normalize custom_fields on a record for export/frontend: ensure it's always an object.
 * Parses JSON string if needed so Admin Data Downloader gets all columns with values.
 */
function normalizeCustomFields(record) {
    if (!record) return record;
    const row = { ...record };
    if (row.custom_fields !== undefined && row.custom_fields !== null) {
        if (typeof row.custom_fields === 'string') {
            try {
                row.custom_fields = JSON.parse(row.custom_fields);
            } catch (e) {
                row.custom_fields = {};
            }
        }
    } else {
        row.custom_fields = {};
    }
    return row;
}

/**
 * Normalize an array of records for list responses (full export).
 */
function normalizeListCustomFields(rows) {
    return Array.isArray(rows) ? rows.map(normalizeCustomFields) : [];
}

module.exports = { normalizeCustomFields, normalizeListCustomFields };
