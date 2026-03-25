/**
 * Zoom Phone API service - users, numbers, call logs.
 * Uses zoomAuth for access token; retries once on 401 after refresh.
 */

const axios = require('axios');
const { getAccessToken } = require('./zoomAuth');
const { clearTokenCache } = require('./zoomService');

const ZOOM_API_BASE = 'https://api.zoom.us/v2';

/**
 * Make authenticated request to Zoom API. On 401, refresh token and retry once.
 * @param {string} method - HTTP method
 * @param {string} url - Full URL or path (if path, base is ZOOM_API_BASE)
 * @param {object} [options] - axios options (params, data, etc.)
 * @returns {Promise<object>} response data
 */
async function zoomRequest(method, url, options = {}) {
  const fullUrl = url.startsWith('http') ? url : `${ZOOM_API_BASE}${url.startsWith('/') ? '' : '/'}${url}`;

  async function doRequest(token) {
    const response = await axios({
      method,
      url: fullUrl,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
      params: options.params,
      data: options.data,
    });
    return response.data;
  }

  try {
    const token = await getAccessToken();
    return await doRequest(token);
  } catch (err) {
    if (err.response && err.response.status === 401) {
      clearTokenCache();
      const token = await getAccessToken();
      return await doRequest(token);
    }
    throw err;
  }
}

/**
 * Get Zoom Phone users.
 * @returns {Promise<object>} Zoom API response (e.g. { users: [...] })
 */
async function getPhoneUsers() {
  return zoomRequest('GET', '/phone/users');
}

/**
 * Get Zoom Phone numbers.
 * @returns {Promise<object>} Zoom API response
 */
async function getPhoneNumbers() {
  return zoomRequest('GET', '/phone/numbers');
}

/**
 * Get Zoom Phone call logs.
 * @param {object} [params] - Query params (e.g. from, to, page_size)
 * @returns {Promise<object>} Zoom API response
 */
async function getCallLogs(params = {}) {
  return zoomRequest('GET', '/phone/call_logs', { params });
}

module.exports = {
  getPhoneUsers,
  getPhoneNumbers,
  getCallLogs,
  zoomRequest,
};
