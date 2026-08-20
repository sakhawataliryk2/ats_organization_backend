/**
 * Call controller - click-to-call (Zoom Phone) start and pending call recording.
 */

const PendingCall = require('../models/PendingCall');

function normalizePhone(number) {
  if (!number) return null;
  let n = String(number).trim();
  n = n.replace(/[^\d+]/g, '');
  if (!n) return null;
  // Zoom can provide internal extensions like "8247". Treat short digit-only
  // values as extensions and do not coerce to E.164.
  if (!n.startsWith('+') && /^[0-9]+$/.test(n) && n.length < 10) {
    return n;
  }

  if (!n.startsWith('+') && /^[0-9]+$/.test(n)) {
    const defaultCountry = process.env.DEFAULT_PHONE_COUNTRY_CODE || '1';
    n = `+${defaultCountry}${n}`;
  }
  return n;
}

class CallController {
  constructor(pool) {
    this.pool = pool;
    this.pendingCallModel = new PendingCall(pool);
  }

  async startCall(req, res) {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ success: false, message: 'Authentication required' });
      }

      const { candidateId, phoneNumber } = req.body || {};
      if (!candidateId || !phoneNumber) {
        return res.status(400).json({
          success: false,
          message: 'candidateId and phoneNumber are required',
        });
      }

      const normalized = normalizePhone(phoneNumber);
      if (!normalized) {
        return res.status(400).json({
          success: false,
          message: 'Invalid phone number',
        });
      }

      const client = await this.pool.connect();
      try {
        const jsResult = await client.query(
          'SELECT id FROM job_seekers WHERE id = $1',
          [candidateId]
        );
        if (!jsResult.rows[0]) {
          return res.status(404).json({
            success: false,
            message: 'Candidate not found',
          });
        }
      } finally {
        client.release();
      }

      await this.pendingCallModel.initTable();
      const isExt = normalized && !String(normalized).startsWith('+');
      await this.pendingCallModel.create({
        candidateId,
        phoneNumber: normalized,
        targetE164: isExt ? null : normalized,
        targetExt: isExt ? String(normalized) : null,
        recruiterUserId: user.id,
      });

      console.log('Zoom call initiated', { candidateId, phoneNumber: normalized });

      // Use Zoom Phone deep-link format that populates the dialer:
      // zoomphonecall://+1234567890
      const dialUrl = `zoomphonecall://${normalized}`;
      return res.status(200).json({
        dialUrl,
      });
    } catch (error) {
      console.error('Error starting call:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while starting call',
        error: process.env.NODE_ENV === 'production' ? undefined : error.message,
      });
    }
  }
}

module.exports = CallController;
