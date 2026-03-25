/**
 * Resolve the record owner's user ID for email notifications.
 * Uses: owner column (if numeric), custom_fields Owner/owner, then created_by.
 * @param {object} record - Job seeker or job record (with owner, custom_fields, created_by)
 * @returns {number|null} User ID or null
 */
function resolveRecordOwnerUserId(record) {
  if (!record) return null;
  const cf = record.custom_fields || {};
  const fromCf = cf.Owner ?? cf.owner;
  const fromColumn = record.owner;
  const fromCreatedBy = record.created_by;
  const candidate =
    fromCf !== undefined &&
    fromCf !== null &&
    String(fromCf).trim() !== ""
      ? fromCf
      : fromColumn !== undefined &&
          fromColumn !== null &&
          String(fromColumn).trim() !== ""
        ? fromColumn
        : fromCreatedBy;
  if (
    candidate === undefined ||
    candidate === null ||
    candidate === ""
  )
    return fromCreatedBy ?? null;
  const num = typeof candidate === "number" ? candidate : parseInt(candidate, 10);
  return Number.isNaN(num) ? (fromCreatedBy ?? null) : num;
}

module.exports = { resolveRecordOwnerUserId };
