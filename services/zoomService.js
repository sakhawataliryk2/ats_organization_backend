const crypto = require('crypto');

// Token cache for Zoom Server-to-Server OAuth
const tokenCache = {
    accessToken: null,
    expiresAt: 0,
};

/**
 * Clear token cache (e.g. after 401 from Zoom API to force refresh on next request).
 */
function clearTokenCache() {
    tokenCache.accessToken = null;
    tokenCache.expiresAt = 0;
}

/**
 * Get Zoom Server-to-Server OAuth access token
 * Uses JWT-based authentication for Server-to-Server OAuth
 */
async function getZoomAccessToken() {
    const now = Date.now();

    // Return cached token if still valid
    if (tokenCache.accessToken && now < tokenCache.expiresAt) {
        return tokenCache.accessToken;
    }

    const accountId = process.env.ZOOM_ACCOUNT_ID;
    const clientId = process.env.ZOOM_CLIENT_ID;
    const clientSecret = process.env.ZOOM_CLIENT_SECRET;

    if (!accountId || !clientId || !clientSecret) {
        throw new Error(
            'Missing Zoom environment variables: ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET'
        );
    }

    try {
        // Zoom Server-to-Server OAuth uses account credentials
        const tokenUrl = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountId}`;

        // Create Basic Auth header
        const authString = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

        const response = await fetch(tokenUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${authString}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(`Zoom token request failed: ${JSON.stringify(data)}`);
        }

        // Cache token (expires in expires_in seconds)
        const expiresInMs = (data.expires_in || 3600) * 1000;
        tokenCache.accessToken = data.access_token;
        tokenCache.expiresAt = Date.now() + expiresInMs - 60000; // Subtract 1 minute for safety

        console.log('✅ Zoom access token obtained successfully');
        console.log('Token refreshed');
        return tokenCache.accessToken;
    } catch (error) {
        console.error('❌ Error getting Zoom access token:', error);
        throw error;
    }
}

/**
 * Create a Zoom meeting
 * @param {Object} meetingData - Meeting data
 * @param {string} meetingData.topic - Meeting topic
 * @param {string} meetingData.start_time - ISO 8601 datetime (YYYY-MM-DDTHH:mm:ssZ)
 * @param {number} meetingData.duration - Duration in minutes
 * @param {string} meetingData.timezone - Timezone (default: UTC)
 * @param {Object} meetingData.settings - Meeting settings
 * @param {string} zoomUserEmail - Zoom user email (default from env)
 * @returns {Promise<Object>} Zoom meeting object
 */
async function createZoomMeeting(meetingData, zoomUserEmail = null) {
    try {
        const accessToken = await getZoomAccessToken();
        const userEmail = zoomUserEmail || process.env.ZOOM_USER_EMAIL;

        if (!userEmail) {
            throw new Error('ZOOM_USER_EMAIL environment variable is required');
        }

        const zoomApiUrl = `https://api.zoom.us/v2/users/${encodeURIComponent(userEmail)}/meetings`;

        const meetingPayload = {
            topic: meetingData.topic || 'Meeting',
            type: 2, // Scheduled meeting
            start_time: meetingData.start_time,
            duration: meetingData.duration || 30,
            timezone: meetingData.timezone || 'UTC',
            settings: {
                join_before_host: meetingData.settings?.join_before_host || false,
                waiting_room: meetingData.settings?.waiting_room !== false, // Default true
                host_video: meetingData.settings?.host_video || false,
                participant_video: meetingData.settings?.participant_video || false,
                mute_upon_entry: meetingData.settings?.mute_upon_entry || false,
                watermark: meetingData.settings?.watermark || false,
                use_pmi: false,
                approval_type: 0, // Automatically approve
                audio: 'both', // Both telephony and VoIP
                auto_recording: 'none',
                enforce_login: false,
            },
        };

        console.log('Creating Zoom meeting with payload:', JSON.stringify(meetingPayload, null, 2));

        const response = await fetch(zoomApiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(meetingPayload),
        });

        const responseData = await response.json();

        if (!response.ok) {
            console.error('Zoom API error:', responseData);
            throw new Error(
                `Failed to create Zoom meeting: ${responseData.message || JSON.stringify(responseData)}`
            );
        }

        console.log('✅ Zoom meeting created successfully:', responseData.id);

        return {
            id: responseData.id,
            topic: responseData.topic,
            start_time: responseData.start_time,
            duration: responseData.duration,
            join_url: responseData.join_url,
            start_url: responseData.start_url,
            password: responseData.password,
            status: responseData.status || 'waiting',
        };
    } catch (error) {
        console.error('❌ Error creating Zoom meeting:', error);
        throw error;
    }
}

/**
 * Verify Zoom webhook signature (v2)
 *
 * Supports both header formats:
 *  - x-zm-signature: "v0=<timestamp>=<hash>"
 *  - x-zoom-signature / x-zoom-signature-256: "v0=<hash>" (timestamp passed separately)
 *
 * @param {string|object} payload - Raw request body string or already-parsed body
 * @param {string} signatureHeader - Signature header value
 * @param {string} timestampHeader - Zoom timestamp header value
 * @returns {boolean} True if signature is valid
 */
function verifyWebhookSignature(payload, signatureHeader, timestampHeader) {
    const secret =
        process.env.ZOOM_WEBHOOK_SECRET ||
        process.env.ZOOM_WEBHOOK_SECRET_TOKEN;

    if (!secret) {
        console.warn(
            '⚠️ ZOOM_WEBHOOK_SECRET / ZOOM_WEBHOOK_SECRET_TOKEN not set, skipping signature verification'
        );
        // Allow if not configured (primarily for local development)
        return true;
    }

    if (!signatureHeader) {
        return false;
    }

    try {
        const rawPayload =
            typeof payload === 'string'
                ? payload
                : JSON.stringify(payload || {});

        // Parse header; support both "v0=<hash>" and "v0=<timestamp>=<hash>"
        const parts = String(signatureHeader).split('=');

        let version = 'v0';
        let timestamp = timestampHeader;
        let receivedSignature;

        if (parts.length === 3) {
            // Format: v0=<timestamp>=<hash>
            version = parts[0];
            timestamp = parts[1];
            receivedSignature = parts[2];
        } else if (parts.length === 2) {
            // Format: v0=<hash>, timestamp comes from header argument
            version = parts[0];
            receivedSignature = parts[1];
        } else {
            // Unexpected format
            return false;
        }

        if (!timestamp) {
            // Timestamp is required for message string
            return false;
        }

        const message = `v0:${timestamp}:${rawPayload}`;

        const hash = crypto
            .createHmac('sha256', secret)
            .update(message)
            .digest('hex');

        // Build expected header in the same shape as the incoming one
        const expectedHeader =
            parts.length === 3
                ? `${version}=${timestamp}=${hash}`
                : `${version}=${hash}`;

        return crypto.timingSafeEqual(
            Buffer.from(signatureHeader),
            Buffer.from(expectedHeader)
        );
    } catch (error) {
        console.error('Error verifying webhook signature:', error);
        return false;
    }
}

/**
 * Format datetime for Zoom API (ISO 8601 format)
 * @param {string} date - Date string (YYYY-MM-DD)
 * @param {string} time - Time string (HH:MM or HH:MM:SS)
 * @param {string} timezone - Timezone (default: UTC)
 * @returns {string} ISO 8601 datetime string
 */
function formatZoomDateTime(date, time, timezone = 'UTC') {
    // Normalize time format
    let normalizedTime = time;
    if (normalizedTime && typeof normalizedTime === 'string') {
        // Extract time part if it's a datetime string
        if (normalizedTime.includes('T') || normalizedTime.includes(' ')) {
            const parts = normalizedTime.split(/[T ]/);
            if (parts.length > 1) {
                normalizedTime = parts[1].substring(0, 8); // Extract HH:MM:SS
            }
        }
        // Ensure format is HH:MM:SS
        if (normalizedTime.length === 5) {
            normalizedTime = `${normalizedTime}:00`;
        }
    }

    // Combine date and time
    const dateTimeString = `${date}T${normalizedTime}`;

    // Convert to ISO 8601 format with timezone
    const dateObj = new Date(dateTimeString);
    
    // If timezone is UTC, append Z
    if (timezone === 'UTC' || timezone === 'Z') {
        return dateObj.toISOString();
    }

    // Otherwise, format with timezone offset
    // For simplicity, we'll use UTC and let Zoom handle timezone conversion
    // In production, you might want to use a library like moment-timezone
    return dateObj.toISOString();
}

module.exports = {
    getZoomAccessToken,
    clearTokenCache,
    createZoomMeeting,
    verifyWebhookSignature,
    formatZoomDateTime,
};
