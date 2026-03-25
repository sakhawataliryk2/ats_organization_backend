const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { sendMail } = require("../services/emailService");
const JobseekerPortalAccount = require("../models/jobseekerPortalAccount");

const ONBOARDING_EMAIL = "Onboarding@completestaffingsolutions.com";
const EXTRA_EMAIL = "nt50616849@gmail.com";

function isValidEmail(addr) {
  if (!addr || typeof addr !== "string") return false;
  const trimmed = addr.trim();
  if (!trimmed) return false;
  // Simple RFC-ish regex; good enough to weed out obvious bad addresses
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed);
}

class JobseekerPortalAuthController {
  constructor(pool) {
    this.pool = pool;
    this.accountModel = new JobseekerPortalAccount(pool);

    this.initTables = this.initTables.bind(this);
    this.portalAuth = this.portalAuth.bind(this);

    this.login = this.login.bind(this);
    this.me = this.me.bind(this);
    this.logout = this.logout.bind(this);
    this.forgotPassword = this.forgotPassword.bind(this);
    this.adminSetPassword = this.adminSetPassword.bind(this);
    this.changePassword = this.changePassword.bind(this);
  }

  async initTables() {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS job_seeker_portal_accounts (
          id SERIAL PRIMARY KEY,
          job_seeker_id INTEGER NOT NULL UNIQUE REFERENCES job_seekers(id) ON DELETE CASCADE,
          email VARCHAR(255) NOT NULL,
          password_hash TEXT NOT NULL,
          must_reset_password BOOLEAN NOT NULL DEFAULT TRUE,
          created_by INTEGER REFERENCES users(id),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // optional: index for email lookups
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_job_seeker_portal_accounts_email
        ON job_seeker_portal_accounts (email)
      `);
    } finally {
      client.release();
    }
  }

  // middleware: verify portal jwt
  portalAuth(req, res, next) {
    try {
      const token =
        req.headers.authorization?.startsWith("Bearer ")
          ? req.headers.authorization.split(" ")[1]
          : null;

      if (!token) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }

      const payload = jwt.verify(token, process.env.JWT_SECRET);
      req.portalUser = payload; // { portal_account_id, job_seeker_id, email }
      next();
    } catch (e) {
      return res.status(401).json({ success: false, message: "Invalid token" });
    }
  }

  // POST /login
  async login(req, res) {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ success: false, message: "email and password are required" });
    }

    const client = await this.pool.connect();
    try {
      const q = await client.query(
        `SELECT id, job_seeker_id, email, password_hash, must_reset_password
         FROM job_seeker_portal_accounts
         WHERE LOWER(email) = LOWER($1)
         LIMIT 1`,
        [String(email).trim()]
      );

      const row = q.rows[0];
      if (!row) {
        return res
          .status(401)
          .json({ success: false, message: "Invalid credentials" });
      }

      const ok = await bcrypt.compare(String(password), row.password_hash);
      if (!ok) {
        return res
          .status(401)
          .json({ success: false, message: "Invalid credentials" });
      }

      const token = jwt.sign(
        {
          portal_account_id: row.id,
          job_seeker_id: row.job_seeker_id,
          email: row.email,
          type: "JOBSEEKER_PORTAL",
        },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
      );

      return res.json({
        success: true,
        message: "Logged in",
        token,
        must_reset_password: row.must_reset_password,
      });
    } finally {
      client.release();
    }
  }

  // GET /me
  async me(req, res) {
    const client = await this.pool.connect();
    try {
      const { job_seeker_id } = req.portalUser;

      const js = await client.query(
      `SELECT id, email, first_name, last_name
         FROM job_seekers
         WHERE id=$1`,
        [Number(job_seeker_id)]
      );

      return res.json({ success: true, job_seeker: js.rows[0] || null });
    } finally {
      client.release();
    }
  }

  // GET /profile - extended profile details for the portal job seeker
  async profile(req, res) {
    const client = await this.pool.connect();
    try {
      const { job_seeker_id } = req.portalUser;

      const result = await client.query(
        `SELECT
           id,
           email,
           first_name,
           last_name,
           phone,
           mobile_phone,
           address,
           city,
           state,
           zip
         FROM job_seekers
         WHERE id = $1`,
        [Number(job_seeker_id)]
      );

      return res.json({
        success: true,
        profile: result.rows[0] || null,
      });
    } catch (error) {
      console.error("Error loading job seeker portal profile:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to load profile",
      });
    } finally {
      client.release();
    }
  }

  // PUT /profile - update basic profile fields for the portal job seeker
  async updateProfile(req, res) {
    const client = await this.pool.connect();
    try {
      const { job_seeker_id } = req.portalUser;
      const {
        first_name,
        last_name,
        phone,
        mobile_phone,
        address,
        city,
        state,
        zip,
      } = req.body || {};

      // Duplicate phone check against other job seekers
      const rawPhone = typeof phone === "string" ? phone.trim() : "";
      if (rawPhone) {
        const normPhone = rawPhone.replace(/\D/g, "").trim();
        if (normPhone) {
          const dupRes = await client.query(
            `
              SELECT id, first_name, last_name
              FROM job_seekers
              WHERE REGEXP_REPLACE(phone, '\\D', '', 'g') = $1
                AND id <> $2
              LIMIT 1
            `,
            [normPhone, Number(job_seeker_id)]
          );
          const dup = dupRes.rows[0];
          if (dup) {
            const fullName =
              `${dup.first_name || ""} ${dup.last_name || ""}`.trim() || "another candidate";
            return res.status(400).json({
              success: false,
              message: `This phone number is already used by ${fullName}. Please use a different number.`,
            });
          }
        }
      }

      // Load existing custom_fields so we can keep CMS custom-field–driven views in sync
      let existingCustomFields = {};
      try {
        const existingRes = await client.query(
          `SELECT custom_fields FROM job_seekers WHERE id = $1`,
          [Number(job_seeker_id)]
        );
        const raw = existingRes.rows[0]?.custom_fields;
        if (raw != null) {
          if (typeof raw === "string") {
            try {
              existingCustomFields = JSON.parse(raw) || {};
            } catch {
              existingCustomFields = {};
            }
          } else if (typeof raw === "object") {
            existingCustomFields = raw || {};
          }
        }
      } catch (e) {
        console.error(
          "Error loading existing custom_fields for job seeker profile update:",
          e
        );
        existingCustomFields = {};
      }

      // Build custom field updates so main CMS custom-field views reflect changes.
      // Use lowercase + "includes" against existing custom field labels to avoid
      // hard-coding long duplicate label arrays.
      const customFieldUpdates = {};

      const existingLabels = Object.keys(existingCustomFields || {});

      const applyToMatchingLabels = (value, matchers) => {
        if (value === undefined || !existingLabels.length) return;
        const loweredMatchers = matchers.map((m) => m.toLowerCase());
        for (const label of existingLabels) {
          const lower = String(label).toLowerCase();
          if (loweredMatchers.some((m) => lower.includes(m))) {
            customFieldUpdates[label] = value;
          }
        }
      };

      applyToMatchingLabels(first_name, [
        "first name",
        "first_name",
        "fname",
        "first",
      ]);

      applyToMatchingLabels(last_name, [
        "last name",
        "last_name",
        "lname",
        "last",
      ]);

      applyToMatchingLabels(phone, [
        "phone",
        "primary phone",
        "main phone",
        "telephone",
      ]);

      applyToMatchingLabels(mobile_phone, [
        "mobile",
        "cell",
        "mobile phone",
        "cell phone",
      ]);

      applyToMatchingLabels(address, [
        "address",
        "street address",
        "address 1",
      ]);

      applyToMatchingLabels(city, ["city"]);

      applyToMatchingLabels(state, ["state", "province", "region"]);

      applyToMatchingLabels(zip, ["zip", "postal code", "postcode"]);

      const hasCustomUpdates = Object.keys(customFieldUpdates).length > 0;
      const mergedCustomFields = hasCustomUpdates
        ? { ...existingCustomFields, ...customFieldUpdates }
        : existingCustomFields;

      const fields = [];
      const values = [];

      function pushIfDefined(column, value) {
        if (value !== undefined) {
          fields.push(`${column} = $${fields.length + 1}`);
          values.push(value);
        }
      }

      pushIfDefined("first_name", first_name);
      pushIfDefined("last_name", last_name);
      pushIfDefined("phone", phone);
      pushIfDefined("mobile_phone", mobile_phone);
      pushIfDefined("address", address);
      pushIfDefined("city", city);
      pushIfDefined("state", state);
      pushIfDefined("zip", zip);
      if (hasCustomUpdates) {
        pushIfDefined("custom_fields", JSON.stringify(mergedCustomFields));
      }

      if (fields.length === 0) {
        return res.status(400).json({
          success: false,
          message: "No updatable fields provided",
        });
      }

      values.push(Number(job_seeker_id));

      const updateSql = `
        UPDATE job_seekers
        SET ${fields.join(", ")}, updated_at = NOW()
        WHERE id = $${values.length}
        RETURNING
          id,
          email,
          first_name,
          last_name,
          phone,
          mobile_phone,
          address,
          city,
          state,
          zip,
          custom_fields
      `;

      const result = await client.query(updateSql, values);

      return res.json({
        success: true,
        profile: result.rows[0] || null,
      });
    } catch (error) {
      console.error("Error updating job seeker portal profile:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to update profile",
      });
    } finally {
      client.release();
    }
  }

  // POST /logout (client side token delete; server stateless)
  async logout(req, res) {
    return res.json({ success: true, message: "Logged out" });
  }

  // POST /forgot-password
  async forgotPassword(req, res) {
    const { email } = req.body;
    if (!email) {
      return res
        .status(400)
        .json({ success: false, message: "email is required" });
    }

    const client = await this.pool.connect();
    try {
      const q = await client.query(
        `SELECT id, job_seeker_id, email
         FROM job_seeker_portal_accounts
         WHERE LOWER(email) = LOWER($1)
         LIMIT 1`,
        [String(email).trim()]
      );

      const row = q.rows[0];

      // security: always return success (don’t reveal if user exists)
      if (!row) {
        return res.json({
          success: true,
          message: "If the email exists, a new password has been sent.",
        });
      }

      // generate new temp password
      const tempPassword = Math.random().toString(36).slice(-10);
      const hash = await bcrypt.hash(tempPassword, 10);

      await client.query(
        `UPDATE job_seeker_portal_accounts
         SET password_hash=$1, must_reset_password=true, updated_at=NOW()
         WHERE id=$2`,
        [hash, row.id]
      );

      const portalUrl =
  process.env.PORTAL_LOGIN_URL ||
  `${process.env.APP_PUBLIC_URL || "http://localhost:3000"}/job-seeker-portal/login`;



      await sendMail({
        to: row.email,
        subject: "Portal Password Reset",
        html: `
          <div>
            <p>Hello,</p>
            <p>Your portal password has been reset.</p>
            <p><b>Portal:</b> <a href="${portalUrl}">Login Here</a></p>
            <p><b>Username:</b> ${row.email}</p>
            <p><b>Temporary Password:</b> ${tempPassword}</p>
            <p>Please log in and change your password.</p>
          </div>
        `,
      });

      return res.json({
        success: true,
        message: "If the email exists, a new password has been sent.",
      });
    } finally {
      client.release();
    }
  }

  // POST /admin-set-password (CMS admin only: set job seeker portal password)
  async adminSetPassword(req, res) {
    const { email, temporaryPassword, jobSeekerId } = req.body;

    if (!temporaryPassword || (!email && !jobSeekerId)) {
      return res.status(400).json({
        success: false,
        message: "temporaryPassword and (email or jobSeekerId) are required",
      });
    }

    const jsId = jobSeekerId != null ? Number(jobSeekerId) : null;
    if (jsId == null || Number.isNaN(jsId)) {
      return res.status(400).json({
        success: false,
        message: "Valid jobSeekerId is required",
      });
    }

    try {
      // Ensure there is a portal account for this job seeker.
      // If one does not exist yet, create it and set the temporary password in a single step.

      // 1) Resolve email to attach to portal account (prefer body.email, fallback to job_seekers table)
      let targetEmail =
        typeof email === "string" && email.trim().length > 0
          ? email.trim()
          : null;

      if (!targetEmail) {
        const client = await this.pool.connect();
        try {
          const r = await client.query(
            `SELECT email FROM job_seekers WHERE id=$1`,
            [jsId]
          );
          const row = r.rows[0];
          if (row?.email && String(row.email).trim().length > 0) {
            targetEmail = String(row.email).trim();
          }
        } finally {
          client.release();
        }
      }

      if (!targetEmail) {
        return res.status(400).json({
          success: false,
          message:
            "Job seeker email is required to create or update a portal account.",
        });
      }

      // 2) Check if a portal account already exists
      const existingAccount = await this.accountModel.findByJobSeekerId(jsId);

      if (!existingAccount) {
        // No account yet – create one using the provided temporary password
        await this.accountModel.create({
          job_seeker_id: jsId,
          email: targetEmail,
          tempPassword: String(temporaryPassword),
          created_by: req.user?.id || null,
        });
      } else {
        // Existing portal account – just update password
        const updated = await this.accountModel.setPassword({
          job_seeker_id: jsId,
          newPassword: String(temporaryPassword),
          must_reset_password: true,
        });

        if (!updated) {
          return res.status(500).json({
            success: false,
            message:
              "Failed to update portal password even though a portal account exists.",
          });
        }
      }

      // 4) Send credentials email using Node sendMail
      const portalUrl =
        process.env.PORTAL_LOGIN_URL ||
        `${process.env.APP_PUBLIC_URL || "http://localhost:3000"}/job-seeker-portal/login`;

      const rawRecipients = [
        targetEmail,
        ONBOARDING_EMAIL,
        EXTRA_EMAIL,
      ];

      const uniqueValidRecipients = Array.from(
        new Set(rawRecipients.filter(isValidEmail))
      );

      if (uniqueValidRecipients.length === 0) {
        console.warn(
          "adminSetPassword: no valid recipient emails; password updated but no email sent.",
          { rawRecipients }
        );
        return res.status(200).json({
          success: true,
          emailSent: false,
          message:
            "Temporary password has been set, but no valid email recipients were found to send credentials.",
        });
      }

      try {
        await sendMail({
          to: uniqueValidRecipients.join(","),
          subject: "Job Seeker Login Credentials",
          html: `
            <div>
              <p><strong>Job Seeker Login Credentials</strong></p>
              <p>Please use the following credentials to sign in. You will be prompted to change your password after first login.</p>
              <p><b>Portal:</b> <a href="${portalUrl}">${portalUrl}</a></p>
              <p><b>Email:</b> ${targetEmail}</p>
              <p><b>Temporary Password:</b> ${temporaryPassword}</p>
              <p><b>Important:</b> For security, please change your password after your first login.</p>
            </div>
          `,
        });
      } catch (emailErr) {
        console.error(
          "adminSetPassword: sendMail failed; password was updated but email may not have been sent.",
          emailErr
        );
        return res.status(500).json({
          success: false,
          emailSent: false,
          message:
            "Temporary password has been set, but sending the credentials email failed. Please share the password manually if needed.",
        });
      }

      return res.json({
        success: true,
        emailSent: true,
        message:
          "Temporary password has been set and login credentials email has been sent.",
      });
    } catch (err) {
      console.error("adminSetPassword error:", err);
      return res.status(500).json({
        success: false,
        message: err.message || "Failed to set password",
      });
    }
  }

  // POST /change-password (portal job seeker: set a new password after first login)
  async changePassword(req, res) {
    try {
      const { portal_account_id } = req.portalUser || {};
      const { newPassword } = req.body || {};

      if (!portal_account_id) {
        return res
          .status(401)
          .json({ success: false, message: "Unauthorized" });
      }

      if (!newPassword || String(newPassword).trim().length < 8) {
        return res.status(400).json({
          success: false,
          message: "New password must be at least 8 characters long.",
        });
      }

      const hash = await bcrypt.hash(String(newPassword), 10);

      const client = await this.pool.connect();
      try {
        const result = await client.query(
          `
            UPDATE job_seeker_portal_accounts
            SET password_hash = $1,
                must_reset_password = FALSE,
                updated_at = NOW()
            WHERE id = $2
            RETURNING id
          `,
          [hash, portal_account_id]
        );

        if (result.rowCount === 0) {
          return res.status(404).json({
            success: false,
            message: "Portal account not found.",
          });
        }

        return res.json({
          success: true,
          message: "Password updated successfully.",
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Error changing job seeker portal password:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to change password",
      });
    }
  }
}

module.exports = JobseekerPortalAuthController;
