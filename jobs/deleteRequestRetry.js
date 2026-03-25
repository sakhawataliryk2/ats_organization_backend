// jobs/deleteRequestRetry.js
// Cron job: Runs every 1 hour. For pending delete requests older than 12 hours:
// 1. Mark as expired
// 2. Create new pending request (unless retry cap reached)
// 3. Send approval email (with optional escalation)
// Full audit history preserved. UTC timestamps. Retry cap configurable.

const DeleteRequest = require("../models/deleteRequest");
const DeleteRequestController = require("../controllers/deleteRequestController");

const MAX_RETRIES = parseInt(process.env.DELETE_REQUEST_MAX_RETRIES || "10", 10);

async function runDeleteRequestRetry(pool) {
  const deleteRequestModel = new DeleteRequest(pool);

  try {
    // Ensure table exists
    await deleteRequestModel.initTable();

    const expiredPending = await deleteRequestModel.getExpiredPendingRequests();
    if (expiredPending.length === 0) {
      return { processed: 0 };
    }

    const controller = new DeleteRequestController(pool);
    const results = [];

    for (const oldRequest of expiredPending) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const { expired, newRequest, capped } = await deleteRequestModel.expireAndCreateNew(
          client,
          oldRequest,
          MAX_RETRIES
        );

        if (!expired) {
          await client.query("ROLLBACK");
          continue; // Already processed by another run
        }

        await client.query("COMMIT");

        if (capped) {
          results.push({ oldId: oldRequest.id, capped: true, recordType: oldRequest.record_type });
          console.log(
            `[DeleteRequestRetry] Expired #${oldRequest.id} (${oldRequest.record_type}) - retry cap reached (${MAX_RETRIES}), no new request created`
          );
          continue;
        }

        results.push({ oldId: oldRequest.id, newId: newRequest.id, recordType: newRequest.record_type });

        // Send approval email for the NEW request (outside transaction)
        // Escalation is auto-applied by controller when retry_count >= threshold
        try {
          await controller.sendDeleteRequestEmail(newRequest, {
            name: newRequest.requested_by_name || "Unknown",
            email: newRequest.requested_by_email || "",
          });
          console.log(
            `[DeleteRequestRetry] Expired #${oldRequest.id}, created #${newRequest.id} (${newRequest.record_type}, retry #${newRequest.retry_count}), email sent`
          );
        } catch (emailError) {
          console.error(
            `[DeleteRequestRetry] Email failed for new request #${newRequest.id}:`,
            emailError.message
          );
          // Don't fail - the new request exists, approver can use dashboard
        }
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`[DeleteRequestRetry] Failed for request #${oldRequest.id}:`, err.message);
        // Continue with next request
      } finally {
        client.release();
      }
    }

    console.log(
      `[DeleteRequestRetry] Completed. Processed ${results.length} expired pending request(s).`
    );
    return { processed: results.length, results };
  } catch (error) {
    console.error("[DeleteRequestRetry] Fatal error:", error);
    throw error;
  }
}

module.exports = { runDeleteRequestRetry };
