const JobSeeker = require("../models/jobseeker");
const User = require("../models/user");
const PendingCall = require("../models/PendingCall");
const crypto = require("crypto");
const { verifyWebhookSignature } = require("../services/zoomService");

class ZoomPhoneController {
  constructor(pool) {
    this.pool = pool;
    this.jobSeekerModel = new JobSeeker(pool);
    this.userModel = new User(pool);
    this.pendingCallModel = new PendingCall(pool);

    this.startCall = this.startCall.bind(this);
    this.handleWebhook = this.handleWebhook.bind(this);
  }

  normalizePhone(number) {
    if (!number) return null;
    let n = String(number).trim().replace(/[^\d+]/g, "");
    if (!n) return null;

    if (!n.startsWith("+") && /^[0-9]+$/.test(n) && n.length >= 10) {
      const defaultCountry = process.env.DEFAULT_PHONE_COUNTRY_CODE || "1";
      n = `+${defaultCountry}${n}`;
    }
    return n;
  }

  async startCall(req, res) {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      const { jobSeekerId, toNumber } = req.body || {};
      if (!jobSeekerId || !toNumber) {
        return res.status(400).json({
          success: false,
          message: "jobSeekerId and toNumber are required",
        });
      }

      const normalizedTo = this.normalizePhone(toNumber);
      if (!normalizedTo) {
        return res.status(400).json({
          success: false,
          message: "Invalid destination phone number",
        });
      }

      const client = await this.pool.connect();
      try {
        const jsResult = await client.query(
          "SELECT id FROM job_seekers WHERE id = $1",
          [jobSeekerId],
        );
        if (!jsResult.rows[0]) {
          return res.status(404).json({
            success: false,
            message: "Job seeker not found",
          });
        }
      } finally {
        client.release();
      }

      await this.pendingCallModel.initTable();
      await this.pendingCallModel.create({
        candidateId: jobSeekerId,
        phoneNumber: normalizedTo,
        recruiterUserId: user.id || null,
        targetE164: normalizedTo,
      });

      console.log("CALL_STARTED", {
        recruiterUserId: user.id || null,
        jobSeekerId,
        normalizedTo,
      });

      return res.status(200).json({
        success: true,
        message: "Call ready to start via Zoom Phone client",
        normalizedTo,
      });
    } catch (error) {
      console.error("Error starting Zoom Phone call:", error);
      return res.status(500).json({
        success: false,
        message: "An error occurred while starting Zoom Phone call",
        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async handleWebhook(req, res) {
    try {
      const event = req.body?.event;
      const payload = req.body?.payload || {};

      console.log("Webhook received:", { event, payload });

      if (event === "endpoint.url_validation") {
        const plainToken = payload?.plainToken || payload?.plain_token;
        if (!plainToken) {
          return res.status(400).json({
            success: false,
            message: "plainToken missing in validation request",
          });
        }

        const secret =
          process.env.ZOOM_WEBHOOK_SECRET ||
          process.env.ZOOM_WEBHOOK_SECRET_TOKEN ||
          "";

        const encryptedToken = crypto
          .createHmac("sha256", secret)
          .update(String(plainToken))
          .digest("hex");

        return res.status(200).json({ plainToken, encryptedToken });
      }

      const authHeader = req.headers["authorization"];
      const bearerToken =
        typeof authHeader === "string" ? authHeader.split(" ")[1] : null;
      const verificationToken = process.env.ZOOM_VERIFICATION_TOKEN;
      const tokenValid =
        bearerToken && verificationToken && bearerToken === verificationToken;

      const signature =
        req.headers["x-zm-signature"] ||
        req.headers["x-zoom-signature-256"] ||
        req.headers["x-zoom-signature"];
      const timestamp =
        req.headers["x-zm-request-timestamp"] ||
        req.headers["x-zoom-request-timestamp"] ||
        req.headers["x-zoom-timestamp"];
      const rawBody = req.rawBody || JSON.stringify(req.body || {});
      const signatureValid = verifyWebhookSignature(rawBody, signature, timestamp);

      const allowInsecureTest =
        process.env.NODE_ENV !== "production" &&
        req.headers["x-zoom-test-webhook"] === "allow-insecure";

      if (!tokenValid && !signatureValid && !allowInsecureTest) {
        return res.status(401).json({
          success: false,
          message: "Invalid Zoom webhook signature/token",
        });
      }

      if (event !== "phone.caller_ended" && event !== "phone.callee_ended") {
        return res.sendStatus(200);
      }

      const data = payload?.object || {};
      const result = await this.processEndedCallEvent(event, data);
      return res.status(200).json({ success: true, event, debug: result });
    } catch (error) {
      console.error("Error handling Zoom Phone webhook:", error);
      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          message: "Error handling Zoom Phone webhook",
          error:
            process.env.NODE_ENV === "production" ? undefined : error.message,
        });
      }
    }
  }

  async processEndedCallEvent(event, data) {
    const callId = data?.call_id || null;
    const fromNumber = this.normalizePhone(data?.caller?.phone_number);
    const toNumber = this.normalizePhone(data?.callee?.phone_number);
    const startTime = data?.connected_start_time || data?.ringing_start_time || null;
    const endTime = data?.call_end_time || null;
    const durationSeconds =
      startTime && endTime
        ? Math.max(
            0,
            Math.floor(
              (new Date(endTime).getTime() - new Date(startTime).getTime()) / 1000,
            ),
          )
        : null;
    const zoomUserId = data?.caller?.user_id || data?.user_id || null;
    const direction = data?.direction || "outbound";
    const userName = data?.caller?.name || null;

    console.log(`${event}:`, data);

    let pendingCall = null;
    let jobSeekerIdOverride = null;

    try {
      await this.pendingCallModel.initTable();

      for (const lookupNumber of [toNumber, fromNumber].filter(Boolean)) {
        pendingCall = await this.pendingCallModel.findLatestByPhoneNumber(lookupNumber);
        if (pendingCall) {
          jobSeekerIdOverride = pendingCall.candidate_id || null;
          break;
        }
      }
    } catch (error) {
      console.warn("Error matching pending call:", error);
    }

    const callResult = await this.logCallNote({
      callId,
      direction,
      fromNumber,
      toNumber: toNumber || pendingCall?.phone_number || null,
      durationSeconds,
      zoomUserId,
      startedAt: startTime,
      endedAt: endTime,
      userName,
      jobSeekerIdOverride,
      recruiterUserIdOverride: pendingCall?.recruiter_user_id || null,
    });

    if (pendingCall?.id) {
      try {
        await this.pendingCallModel.markCompleted(pendingCall.id);
      } catch (error) {
        console.warn("Error marking pending call completed:", error);
      }
    }

    return {
      callId,
      fromNumber,
      toNumber,
      pendingCallId: pendingCall?.id || null,
      jobSeekerIdLogged: callResult?.jobSeekerId || null,
      callLogged: Boolean(callResult?.logged),
    };
  }

  async findJobSeekerIdByPhone(number) {
    if (!number) return null;
    const client = await this.pool.connect();
    try {
      const norm = this.normalizePhone(number);
      const digits = norm ? String(norm).replace(/[^\d]/g, "") : "";
      const last10 = digits.length >= 10 ? digits.slice(-10) : digits;

      if (!last10) return null;

      const query = `
        SELECT id
        FROM job_seekers
        WHERE
          RIGHT(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = $1
          OR RIGHT(regexp_replace(COALESCE(mobile_phone, ''), '\\D', '', 'g'), 10) = $1
        LIMIT 1
      `;
      const result = await client.query(query, [last10]);
      return result.rows[0]?.id || null;
    } catch (error) {
      console.error("Error finding job seeker by phone:", error);
      return null;
    } finally {
      client.release();
    }
  }

  async findUserIdByZoomIdentifier(zoomUserId) {
    if (!zoomUserId) return null;
    try {
      const user = this.userModel.getByZoomId
        ? await this.userModel.getByZoomId(zoomUserId)
        : null;
      return user?.id || null;
    } catch (error) {
      console.error("Error finding user by Zoom ID:", error);
      return null;
    }
  }

  formatDuration(seconds) {
    if (!seconds || Number.isNaN(Number(seconds))) return "Unknown";
    const s = Math.max(0, parseInt(seconds, 10));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m === 0 ? `${r}s` : `${m}m ${r}s`;
  }

  formatDate(dateLike) {
    if (!dateLike) return new Date().toLocaleString("en-US");
    const d = new Date(dateLike);
    if (Number.isNaN(d.getTime())) return String(dateLike);
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  async logCallNote({
    callId,
    direction,
    fromNumber,
    toNumber,
    durationSeconds,
    zoomUserId,
    startedAt,
    endedAt,
    userName,
    jobSeekerIdOverride,
    recruiterUserIdOverride,
  }) {
    try {
      const number =
        direction === "inbound" ? fromNumber : toNumber || fromNumber;

      let jobSeekerId = jobSeekerIdOverride || null;
      if (!jobSeekerId) {
        jobSeekerId =
          (await this.findJobSeekerIdByPhone(number)) ||
          (await this.findJobSeekerIdByPhone(fromNumber)) ||
          (await this.findJobSeekerIdByPhone(toNumber));
      }

      if (!jobSeekerId) {
        console.warn("No matching job seeker for number", number);
        return { logged: false, jobSeekerId: null };
      }

      const userId =
        recruiterUserIdOverride ||
        (await this.findUserIdByZoomIdentifier(zoomUserId));
      const durationText = this.formatDuration(durationSeconds);
      const dateText = this.formatDate(endedAt || startedAt || new Date());

      const directionLabel =
        direction === "inbound"
          ? "Inbound"
          : direction === "outbound"
            ? "Outbound"
            : "Unknown";

      const lines = [
        "Call Log",
        `Type: ${directionLabel}`,
        `Number: ${number || "Unknown"}`,
        `Duration: ${durationText}`,
        ...(userName ? [`Recruiter: ${userName}`] : []),
        `Date: ${dateText}`,
      ];

      await this.jobSeekerModel.addNoteAndUpdateContact(
        jobSeekerId,
        lines.join("\n"),
        userId || null,
        "call",
        "Zoom Call",
        [
          {
            type: "zoom_call",
            id: callId || `${Date.now()}`,
            display: callId ? `Zoom Call #${callId}` : "Zoom Call",
            value: callId ? `#${callId}` : "Zoom Call",
            source: "zoom_phone_webhook",
            zoomUserId,
            direction,
            fromNumber,
            toNumber,
            durationSeconds,
            startedAt,
            endedAt,
          },
        ],
      );

      console.log("CALL_LOGGED", {
        callId: callId || null,
        jobSeekerId,
        createdByUserId: userId || null,
      });

      return { logged: true, jobSeekerId };
    } catch (error) {
      console.error("Error logging call note:", error);
      return { logged: false, jobSeekerId: null, error: error?.message || String(error) };
    }
  }
}

module.exports = ZoomPhoneController;
