#!/usr/bin/env node
/**
 * Send a simulated phone.cdr.completed webhook to the local backend.
 * Use this to test call logging without a paid Zoom Phone account.
 *
 * Usage:
 *   node scripts/send-test-zoom-webhook.js +15551234567
 *   node scripts/send-test-zoom-webhook.js +15551234567 http://localhost:8080
 *
 * The number (callee_number) must match a job seeker's phone or mobile_phone in the DB,
 * or match a pending_calls.phone_number row if you clicked "Call" first.
 */

const crypto = require('crypto');
const http = require('http');
const https = require('https');

const calleeNumber = process.argv[2] || '+15551234567';
const baseUrl = process.argv[3] || 'http://localhost:8080';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const payload = {
  event: 'phone.cdr.completed',
  payload: {
    object: {
      caller_number: '+15550001111',
      callee_number: calleeNumber,
      duration: 240,
      user_name: 'John Recruiter',
      date_time: new Date().toISOString(),
    },
  },
};

const body = JSON.stringify(payload);
const secret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN || process.env.ZOOM_WEBHOOK_SECRET;
const timestamp = String(Date.now());

let signatureHeader;
if (secret) {
  const message = `v0:${timestamp}:${body}`;
  const hash = crypto.createHmac('sha256', secret).update(message).digest('hex');
  signatureHeader = `v0=${timestamp}=${hash}`;
} else {
  console.warn('No ZOOM_WEBHOOK_SECRET_TOKEN set — request may be rejected (use Bearer token instead).');
}

const url = new URL(baseUrl);
const isHttps = url.protocol === 'https:';
const lib = isHttps ? https : http;

const options = {
  hostname: url.hostname,
  port: url.port || (isHttps ? 443 : 80),
  path: '/webhooks/zoom',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'x-zm-signature': signatureHeader || '',
    'x-zm-request-timestamp': timestamp,
  },
};

const verificationToken = process.env.ZOOM_VERIFICATION_TOKEN;
if (verificationToken) {
  options.headers['Authorization'] = `Bearer ${verificationToken}`;
}

const req = lib.request(options, (res) => {
  let data = '';
  res.on('data', (ch) => { data += ch; });
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    try {
      console.log('Response:', JSON.stringify(JSON.parse(data), null, 2));
    } catch {
      console.log('Response:', data);
    }
    process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
  });
});

req.on('error', (err) => {
  console.error('Request error:', err.message);
  process.exit(1);
});

req.write(body);
req.end();
