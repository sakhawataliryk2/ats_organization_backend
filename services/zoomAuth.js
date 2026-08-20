/**
 * Zoom OAuth service - delegates to zoomService for Server-to-Server OAuth.
 * Use this for Zoom Phone API and other Zoom API calls that need an access token.
 */

const { getZoomAccessToken } = require('./zoomService');

/**
 * Get Zoom access token (cached ~1 hour, auto-refresh when expired).
 * @returns {Promise<string>} access_token
 */
async function getAccessToken() {
  return getZoomAccessToken();
}

module.exports = {
  getAccessToken,
};
