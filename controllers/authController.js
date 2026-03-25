const User = require("../models/user");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const EmailTemplateModel = require("../models/emailTemplateModel");

const { sendMail } = require("../services/emailService");
const baseUrl = process.env.FRONTEND_URL || "http://localhost:3000";
const TWO_FA_TEMPLATE_TYPE = "AUTH_2FA_EMAIL";
const RESET_PASSWORD_TEMPLATE_TYPE = "AUTH_RESET_PASSWORD_EMAIL";
const WELCOME_TEMPLATE_TYPE = "WELCOME_EMAIL";
const TEST_2FA_BYPASS_EMAIL = (process.env.TEST_BYPASS_2FA_EMAIL || "test@gmail.com").toLowerCase();
const OWNER_2FA_BYPASS_EMAIL = "owner@gmail.com";

function generateStrongPassword() {
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const upper = "ABCDEFGHJKMNPQRSTUVWXYZ";
  const num = "23456789";
  const special = "!@#$%&*";
  const pick = (str, n) => {
    let out = "";
    for (let i = 0; i < n; i++) out += str[Math.floor(Math.random() * str.length)];
    return out;
  };
  const part = pick(lower, 3) + pick(upper, 3) + pick(num, 2) + pick(special, 2);
  return part
    .split("")
    .sort(() => Math.random() - 0.5)
    .join("");
}

function generateNumericOtp(length = 6) {
  let otp = "";
  for (let i = 0; i < length; i++) {
    otp += Math.floor(Math.random() * 10).toString();
  }
  return otp;
}

class AuthController {
  constructor(pool) {
    this.userModel = new User(pool);
    this.emailTemplateModel = new EmailTemplateModel(pool);
    this.signup = this.signup.bind(this);
    this.login = this.login.bind(this);
    this.logout = this.logout.bind(this);
    this.verifyOtp = this.verifyOtp.bind(this);
    this.forgotPassword = this.forgotPassword.bind(this);
    this.resetPassword = this.resetPassword.bind(this);
    this.changePassword = this.changePassword.bind(this);
  }

  // Initialize database tables
  async initTables() {
    await this.userModel.initTable();
  }

  // Create initial developer account (only allowed if no users exist)
  async createInitialDeveloper(req, res) {
    const { name, email, password } = req.body;

    // Input validation
    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Name, email and password are required",
      });
    }

    try {
      // Check if any users already exist
      const existingUsers = await this.userModel.getAllDetailed();
      if (existingUsers.length > 0) {
        return res.status(403).json({
          success: false,
          message:
            "Initial developer account can only be created when no users exist",
        });
      }

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({
          success: false,
          message: "Invalid email format",
        });
      }

      // Enhanced password validation
      const passwordValidation = this.validatePassword(password);
      if (!passwordValidation.isValid) {
        return res.status(400).json({
          success: false,
          message: passwordValidation.message,
        });
      }

      // Create developer user
      const user = await this.userModel.create({
        name,
        email,
        password,
        userType: "developer",
        isAdmin: true,
      });

      // Send success response
      res.status(201).json({
        success: true,
        message: "Initial developer account created successfully",
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          token: user.token,
        },
      });
    } catch (error) {
      console.error("Error creating initial developer:", error);

      if (error.message === "User with this email already exists") {
        return res.status(409).json({
          success: false,
          message: "User with this email already exists",
        });
      }

      res.status(500).json({
        success: false,
        message: "An error occurred during account creation",
        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  // Handle user signup (restricted - only for developers creating other users)
  async signup(req, res) {
    const {
      name,
      email,
      password,
      userType,
      officeId,
      teamId,
      phone,
      phone2,
      title,
      idNumber,
      isAdmin,
    } = req.body;

    // Input validation (password optional when auto-generate is used)
    if (!name || !email || !userType) {
      return res.status(400).json({
        success: false,
        message: "Name, email and user type are required",
      });
    }
    const useAutoPassword =
      !password || (typeof password === "string" && password.trim() === "");

    // Check if user is authenticated
    // if (!req.user) {
    //     return res.status(401).json({
    //         success: false,
    //         message: 'Authentication required to create user accounts'
    //     });
    // }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email format",
      });
    }

    // Password: either manual (validated) or auto-generated
    let passwordToUse = password;
    let plainPasswordForResponse = null;
    if (useAutoPassword) {
      plainPasswordForResponse = generateStrongPassword();
      const hashed = await bcrypt.hash(plainPasswordForResponse, 10);
      passwordToUse = hashed;
    } else {
      const passwordValidation = this.validatePassword(password);
      if (!passwordValidation.isValid) {
        return res.status(400).json({
          success: false,
          message: passwordValidation.message,
        });
      }
    }

    // Validate user type
    const validUserTypes = [
      "candidate",
      "recruiter",
      "developer",
      "admin",
      "owner",
      "administrator",
      "payroll-admin",
      "onboarding-admin",
      "account-manager-temp",
      "account-manager-perm",
      "sales-rep",
    ];
    if (!validUserTypes.includes(userType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user type",
      });
    }

    // Role-based creation restrictions (only if req.user exists)
    if (
      req.user &&
      req.user.role === "admin" &&
      (userType === "developer" || userType === "owner")
    ) {
      return res.status(403).json({
        success: false,
        message: "Admins cannot create developer or owner accounts",
      });
    }

    // Validate office and team requirements for non-admin roles
    if (userType === "candidate" || userType === "recruiter") {
      if (!officeId || !teamId) {
        return res.status(400).json({
          success: false,
          message: "Office and team are required for candidates and recruiters",
        });
      }
    }

    try {
      // Create user in database
      const user = await this.userModel.create({
        name,
        email,
        password: passwordToUse,
        passwordAlreadyHashed: !!useAutoPassword,
        userType,
        officeId,
        teamId,
        phone,
        phone2,
        title,
        idNumber,
        isAdmin:
          isAdmin === true ||
          userType === "admin" ||
          userType === "developer" ||
          userType === "owner" ||
          userType === "administrator",
        // Any account created with an auto-generated password must change it on first login.
        mustChangePassword: useAutoPassword === true,
      });

      // Fire-and-forget welcome email to the new user.
      // This uses the configurable WELCOME_EMAIL template when present;
      // on failure we only log and do not block signup.
      (async () => {
        try {
          const portalUrl = baseUrl;
          const template = this.emailTemplateModel
            ? await this.emailTemplateModel.getTemplateByType(
                WELCOME_TEMPLATE_TYPE
              )
            : null;

          const context = {
            userName: user.name || "",
            email: user.email || "",
            userType: user.role || userType,
            portalUrl,
            // Password is only known at creation time. We include it in the email
            // but NEVER store it in the database in plain text.
            password: plainPasswordForResponse || (useAutoPassword ? "" : password),
          };

          const applyPlaceholders = (input) =>
            typeof input === "string"
              ? input.replace(
                  /{{\s*(userName|email|userType|portalUrl|password)\s*}}/g,
                  (match, key) => context[key] || ""
                )
              : input;

          let subject = `Welcome to the ATS, ${context.userName || context.email}`;
          let html = `
            <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; background-color: #f4f4f5;">
              <div style="background-color: #ffffff; border-radius: 12px; padding: 24px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);">
                <h1 style="margin: 0 0 16px; font-size: 20px; color: #111827;">Welcome to Complete Staffing Solutions</h1>
                <p style="margin: 0 0 12px; font-size: 14px; color: #374151;">
                  Hello ${context.userName || ""},
                </p>
                <p style="margin: 0 0 12px; font-size: 14px; color: #374151;">
                  Your user account has been created with the email <strong>${context.email}</strong>${context.userType ? ` and role <strong>${context.userType}</strong>` : ""}.
                </p>
                ${
                  context.password
                    ? `<p style="margin: 0 0 12px; font-size: 14px; color: #374151;">
                         Your password is: <strong>${context.password}</strong>
                       </p>`
                    : ""
                }
                <p style="margin: 0 0 12px; font-size: 14px; color: #374151;">
                  You can access the system here:
                  <a href="${portalUrl}" style="color:#2563eb; text-decoration:underline;">${portalUrl}</a>
                </p>
                <p style="margin: 0 0 0; font-size: 13px; color: #4b5563;">
                  If you did not expect this account, please contact an administrator.
                </p>
              </div>
              <p style="margin: 16px 0 0; font-size: 11px; color: #9ca3af; text-align: center;">
                Sent to ${context.email}.
              </p>
            </div>
          `;

          if (template) {
            subject =
              applyPlaceholders(template.subject) ||
              subject;
            html =
              applyPlaceholders(template.body) ||
              html;
          }

          await sendMail({
            to: user.email,
            subject,
            html,
          });
        } catch (welcomeError) {
          console.error("Error sending welcome email:", welcomeError);
        }
      })();

      // Send success response (include userId; include plainPassword only when auto-generated, once)
      const payload = {
        success: true,
        message: "User created successfully",
        user: {
          id: user.id,
          userId: user.userId,
          name: user.name,
          email: user.email,
          role: user.role,
          officeId: user.officeId,
          teamId: user.teamId,
          token: user.token,
        },
      };
      if (plainPasswordForResponse) {
        payload.user.plainPassword = plainPasswordForResponse;
      }
      res.status(201).json(payload);
    } catch (error) {
      console.error("Error creating user:", error);
      console.error("Error stack:", error.stack);
      console.error("Request body:", req.body);

      if (error.message === "User with this email already exists") {
        return res.status(409).json({
          success: false,
          message: "User with this email already exists",
        });
      }

      res.status(500).json({
        success: false,
        message: "An error occurred during user creation",
        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  // Password validation helper method
  validatePassword(password) {
    // Check length
    if (password.length < 8) {
      return {
        isValid: false,
        message: "Password must be at least 8 characters long",
      };
    }

    // Check for lowercase letter
    if (!/[a-z]/.test(password)) {
      return {
        isValid: false,
        message: "Password must contain at least one lowercase letter",
      };
    }

    // Check for uppercase letter
    if (!/[A-Z]/.test(password)) {
      return {
        isValid: false,
        message: "Password must contain at least one uppercase letter",
      };
    }

    // Check for number
    if (!/[0-9]/.test(password)) {
      return {
        isValid: false,
        message: "Password must contain at least one number",
      };
    }

    // Check for special character
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
      return {
        isValid: false,
        message: "Password must contain at least one special character",
      };
    }

    return {
      isValid: true,
      message: "Password is valid",
    };
  }

  async sendLoginOtpEmail(user, otp, expiresAt) {
    const fallbackSubject = "Your login verification code";
    const formattedExpiry = expiresAt.toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

    let subject = fallbackSubject;
    let html = `
      <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; background-color: #f4f4f5;">
        <div style="background-color: #ffffff; border-radius: 12px; padding: 24px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);">
          <h1 style="margin: 0 0 16px; font-size: 20px; color: #111827;">Two-factor authentication</h1>
          <p style="margin: 0 0 12px; font-size: 14px; color: #374151;">
            Hello ${user.name || ""}, use the verification code below to finish signing in.
          </p>
          <div style="margin: 20px 0; text-align: center;">
            <span style="display: inline-block; letter-spacing: 0.35em; font-size: 26px; font-weight: 600; padding: 12px 18px; border-radius: 999px; background-color: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe;">
              ${otp}
            </span>
          </div>
          <p style="margin: 0 0 8px; font-size: 13px; color: #4b5563;">
            This code will expire at <strong>${formattedExpiry}</strong>.
          </p>
          <p style="margin: 0 0 8px; font-size: 12px; color: #6b7280;">
            If you did not try to sign in, you can safely ignore this email.
          </p>
        </div>
        <p style="margin: 16px 0 0; font-size: 11px; color: #9ca3af; text-align: center;">
          Sent to ${user.email || ""} for secure access.
        </p>
      </div>
    `;

    try {
      if (this.emailTemplateModel) {
        const template = await this.emailTemplateModel.getTemplateByType(
          TWO_FA_TEMPLATE_TYPE
        );

        if (template) {
          const context = {
            userName: user.name || "",
            email: user.email || "",
            otp,
            expiresAt: formattedExpiry,
          };

          const applyPlaceholders = (input) =>
            typeof input === "string"
              ? input.replace(
                  /{{\s*(userName|email|otp|expiresAt)\s*}}/g,
                  (match, key) => context[key] || ""
                )
              : input;

          subject = applyPlaceholders(template.subject) || fallbackSubject;
          html = applyPlaceholders(template.body) || html;
        }
      }
    } catch (error) {
      console.error("Error loading 2FA email template:", error);
    }

    await sendMail({
      to: user.email,
      subject,
      html,
    });
  }

  async sendResetPasswordOtpEmail(user, otp, expiresAt) {
    const fallbackSubject = "Your password reset code";
    const formattedExpiry = expiresAt.toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

    let subject = fallbackSubject;
    let html = `
      <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; background-color: #f4f4f5;">
        <div style="background-color: #ffffff; border-radius: 12px; padding: 24px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);">
          <h1 style="margin: 0 0 16px; font-size: 20px; color: #111827;">Password reset request</h1>
          <p style="margin: 0 0 12px; font-size: 14px; color: #374151;">
            Hello ${user.name || ""}, use the verification code below to reset your password.
          </p>
          <div style="margin: 20px 0; text-align: center;">
            <span style="display: inline-block; letter-spacing: 0.35em; font-size: 26px; font-weight: 600; padding: 12px 18px; border-radius: 999px; background-color: #fffbeb; color: #92400e; border: 1px solid #fcd34d;">
              ${otp}
            </span>
          </div>
          <p style="margin: 0 0 8px; font-size: 13px; color: #4b5563;">
            This code will expire at <strong>${formattedExpiry}</strong>.
          </p>
          <p style="margin: 0 0 8px; font-size: 12px; color: #6b7280;">
            If you did not request a password reset, you can safely ignore this email and your password will remain unchanged.
          </p>
        </div>
        <p style="margin: 16px 0 0; font-size: 11px; color: #9ca3af; text-align: center;">
          Sent to ${user.email || ""} for your security.
        </p>
      </div>
    `;

    try {
      if (this.emailTemplateModel) {
        const template = await this.emailTemplateModel.getTemplateByType(
          RESET_PASSWORD_TEMPLATE_TYPE
        );

        if (template) {
          const context = {
            userName: user.name || "",
            email: user.email || "",
            otp,
            expiresAt: formattedExpiry,
          };

          const applyPlaceholders = (input) =>
            typeof input === "string"
              ? input.replace(
                  /{{\s*(userName|email|otp|expiresAt)\s*}}/g,
                  (match, key) => context[key] || ""
                )
              : input;

          subject = applyPlaceholders(template.subject) || fallbackSubject;
          html = applyPlaceholders(template.body) || html;
        }
      }
    } catch (error) {
      console.error("Error loading reset password email template:", error);
    }

    await sendMail({
      to: user.email,
      subject,
      html,
    });
  }

  // Handle user login
  async login(req, res) {
    let { email, password } = req.body;

    // Input validation
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    try {
      // Find user by email
      const user = await this.userModel.findByEmail(email.trim());

      // Check if user exists
      if (!user) {
        console.warn("[Auth] Failed login attempt: user not found", email);
        return res.status(401).json({
          success: false,
          message: "Invalid email or password",
        });
      }

      // Check if user is active
      if (!user.status) {
        console.warn("[Auth] Failed login attempt: account deactivated", { userId: user.id, email: email?.substring(0, 5) + "***", timestamp: new Date().toISOString() });
        return res.status(401).json({
          success: false,
          message: "Your account has been deactivated. Please contact support.",
        });
      } 

      // Check if password exists
      if (!user.password) {
        console.error("[Auth] User found but password field is missing", { userId: user.id });
        return res.status(500).json({
          success: false,
          message: "Account configuration error. Please contact support.",
        });
      }

      // Compare passwords
      const isPasswordValid = await bcrypt.compare(password, user.password);

      if (!isPasswordValid) {
        console.warn("[Auth] Failed login attempt: invalid password", { userId: user.id, email: email?.substring(0, 5) + "***", timestamp: new Date().toISOString() });
        return res.status(401).json({
          success: false,
          message: "Invalid email or password",
        });
      }

      // Bypass 2FA for configured test/owner emails
      const userEmailLower = (user.email || "").toLowerCase();
      if (
        userEmailLower === TEST_2FA_BYPASS_EMAIL ||
        userEmailLower === OWNER_2FA_BYPASS_EMAIL
      ) {
        const token = jwt.sign(
          { userId: user.id, email: user.email, userType: user.role },
          process.env.JWT_SECRET || "default_secret_key",
          { expiresIn: "7d" }
        );

        await this.userModel.updateToken(user.id, token);
        await this.userModel.clearOtp(user.id);

        return res.status(200).json({
          success: true,
          message: "Login successful",
          token,
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            userType: user.role,
            role: user.role,
            token,
          },
        });
      }

      const otp = generateNumericOtp(6);
      const ttlSeconds = Number(process.env.LOGIN_OTP_TTL_SECONDS || 600);
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

      const shouldHashOtp = process.env.NODE_ENV === "production";
      const otpToStore = shouldHashOtp ? await bcrypt.hash(otp, 10) : otp;

      await this.userModel.setOtp(user.id, otpToStore, expiresAt);

      try {
        await this.sendLoginOtpEmail(user, otp, expiresAt);
      } catch (emailError) {
        console.error("Error sending login OTP email:", emailError);
        return res.status(500).json({
          success: false,
          message: "Failed to send verification code. Please try again later.",
        });
      }

      return res.status(200).json({
        success: true,
        message: "Verification code sent to your email",
        requires2FA: true,
      });
    } catch (error) {
      console.error("Error during login:", error);
      console.error("Error stack:", error.stack);
      console.error("Login request body:", { email: email ? email.substring(0, 5) + "..." : "missing" });
      res.status(500).json({
        success: false,
        message: "An error occurred during login",
        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async forgotPassword(req, res) {
    let { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    email = email.toLowerCase().trim();

    try {
      const user = await this.userModel.findByEmail(email);

      if (!user) {
        // To avoid leaking which emails exist, return generic success
        return res.status(200).json({
          success: true,
          message: "If an account exists for this email, a reset code has been sent.",
        });
      }

      if (!user.status) {
        return res.status(400).json({
          success: false,
          message:
            "Your account has been deactivated. Please contact support.",
        });
      }

      const otp = generateNumericOtp(6);
      const ttlSeconds = Number(
        process.env.RESET_PASSWORD_OTP_TTL_SECONDS ||
          process.env.LOGIN_OTP_TTL_SECONDS ||
          600
      );
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

      const shouldHashOtp = process.env.NODE_ENV === "production";
      const otpToStore = shouldHashOtp ? await bcrypt.hash(otp, 10) : otp;

      await this.userModel.setOtp(user.id, otpToStore, expiresAt);

      try {
        await this.sendResetPasswordOtpEmail(user, otp, expiresAt);
      } catch (emailError) {
        console.error("Error sending reset password OTP email:", emailError);
        return res.status(500).json({
          success: false,
          message:
            "Failed to send reset code. Please try again later.",
        });
      }

      return res.status(200).json({
        success: true,
        message:
          "If an account exists for this email, a reset code has been sent.",
      });
    } catch (error) {
      console.error("Error during forgot password:", error);
      console.error("Error stack:", error.stack);
      return res.status(500).json({
        success: false,
        message: "An error occurred while requesting password reset",
        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async resetPassword(req, res) {
    let { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Email, OTP and new password are required",
      });
    }

    const passwordValidation = this.validatePassword(newPassword);
    if (!passwordValidation.isValid) {
      return res.status(400).json({
        success: false,
        message: passwordValidation.message,
      });
    }

    email = email.toLowerCase().trim();
    otp = String(otp).trim();

    try {
      const user = await this.userModel.findByEmail(email);

      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Invalid verification code or email",
        });
      }

      if (!user.status) {
        return res.status(401).json({
          success: false,
          message:
            "Your account has been deactivated. Please contact support.",
        });
      }

      if (!user.otp_code || !user.otp_expires_at) {
        return res.status(400).json({
          success: false,
          message:
            "No active verification code found. Please request a new reset code.",
        });
      }

      const now = new Date();
      const expiresAt = new Date(user.otp_expires_at);

      if (expiresAt.getTime() <= now.getTime()) {
        await this.userModel.clearOtp(user.id);
        return res.status(400).json({
          success: false,
          message: "Verification code has expired. Please request a new one.",
        });
      }

      const shouldHashOtp = process.env.NODE_ENV === "production";
      let isValidOtp;

      if (shouldHashOtp) {
        isValidOtp = await bcrypt.compare(otp, user.otp_code);
      } else {
        isValidOtp = otp === String(user.otp_code || "").trim();
      }

      if (!isValidOtp) {
        return res.status(401).json({
          success: false,
          message: "Invalid verification code",
        });
      }

      await this.userModel.updatePassword(user.id, newPassword);
      await this.userModel.clearOtp(user.id);

      return res.status(200).json({
        success: true,
        message: "Password has been reset successfully. You can now log in with your new password.",
      });
    } catch (error) {
      console.error("Error during password reset:", error);
      console.error("Error stack:", error.stack);
      return res.status(500).json({
        success: false,
        message: "An error occurred while resetting the password",
        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  // Change password for authenticated users (e.g., after first login with temporary password)
  async changePassword(req, res) {
    const { currentPassword, newPassword } = req.body || {};

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Current password and new password are required",
      });
    }

    const passwordValidation = this.validatePassword(newPassword);
    if (!passwordValidation.isValid) {
      return res.status(400).json({
        success: false,
        message: passwordValidation.message,
      });
    }

    try {
      const authHeader = req.headers.authorization || "";
      const token = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : null;

      if (!token) {
        return res.status(401).json({
          success: false,
          message: "Authentication token is required",
        });
      }

      const decoded = jwt.verify(
        token,
        process.env.JWT_SECRET || "default_secret_key"
      );

      const user = await this.userModel.findById(decoded.userId);
      if (!user) {
        return res.status(401).json({
          success: false,
          message: "User not found",
        });
      }

      const isCurrentValid = await bcrypt.compare(
        currentPassword,
        user.password
      );
      if (!isCurrentValid) {
        return res.status(401).json({
          success: false,
          message: "Current password is incorrect",
        });
      }

      await this.userModel.updatePassword(user.id, newPassword);

      return res.status(200).json({
        success: true,
        message: "Password updated successfully",
      });
    } catch (error) {
      console.error("Error during changePassword:", error);
      return res.status(500).json({
        success: false,
        message: "An error occurred while updating password",
      });
    }
  }
  async verifyOtp(req, res) {
    let { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        message: "Email and OTP are required",
      });
    }

    email = email.toLowerCase().trim();
    otp = String(otp).trim();

    try {
      const user = await this.userModel.findByEmail(email);

      if (!user) {
        console.warn("[Auth] OTP verification failed: user not found", {
          email: email?.substring(0, 5) + "***",
          timestamp: new Date().toISOString(),
        });
        return res.status(401).json({
          success: false,
          message: "Invalid verification code or email",
        });
      }

      if (!user.status) {
        console.warn("[Auth] OTP verification failed: account deactivated", {
          userId: user.id,
          email: email?.substring(0, 5) + "***",
          timestamp: new Date().toISOString(),
        });
        return res.status(401).json({
          success: false,
          message:
            "Your account has been deactivated. Please contact support.",
        });
      }

      if (!user.otp_code || !user.otp_expires_at) {
        return res.status(400).json({
          success: false,
          message: "No active verification code found. Please login again.",
        });
      }

      const now = new Date();
      const expiresAt = new Date(user.otp_expires_at);

      if (expiresAt.getTime() <= now.getTime()) {
        await this.userModel.clearOtp(user.id);
        return res.status(400).json({
          success: false,
          message: "Verification code has expired. Please login again.",
        });
      }

      const shouldHashOtp = process.env.NODE_ENV === "production";
      let isValidOtp;

      if (shouldHashOtp) {
        isValidOtp = await bcrypt.compare(otp, user.otp_code);
      } else {
        isValidOtp = otp === String(user.otp_code || "").trim();
      }

      if (!isValidOtp) {
        console.warn("[Auth] OTP verification failed: invalid code", {
          userId: user.id,
          email: email?.substring(0, 5) + "***",
          timestamp: new Date().toISOString(),
        });
        return res.status(401).json({
          success: false,
          message: "Invalid verification code",
        });
      }

      const token = jwt.sign(
        {
          userId: user.id,
          email: user.email,
          userType: user.role,
          mustChangePassword: !!user.must_change_password,
        },
        process.env.JWT_SECRET || "default_secret_key",
        { expiresIn: "7d" }
      );

      await this.userModel.updateToken(user.id, token);
      await this.userModel.clearOtp(user.id);

      return res.status(200).json({
        success: true,
        message: "Login successful",
        token,
        mustChangePassword: !!user.must_change_password,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          userType: user.role,
          role: user.role,
          token,
          mustChangePassword: !!user.must_change_password,
        },
      });
    } catch (error) {
      console.error("Error during OTP verification:", error);
      console.error("Error stack:", error.stack);
      return res.status(500).json({
        success: false,
        message: "An error occurred during OTP verification",
        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  // Handle user logout
  async logout(req, res) {
    try {
      const token = req.headers.authorization?.split(" ")[1];

      if (!token) {
        return res.status(400).json({
          success: false,
          message: "No token provided",
        });
      }

      // Find user by token
      const user = await this.userModel.findByToken(token);

      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Invalid token",
        });
      }

      // Clear the token in the database
      await this.userModel.updateToken(user.id, null);

      res.status(200).json({
        success: true,
        message: "Logout successful",
      });
    } catch (error) {
      console.error("Error during logout:", error);
      res.status(500).json({
        success: false,
        message: "An error occurred during logout",
        error:
          process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  // async sendResetPasswordEmail(req, res) {
  //   const { email } = req.body;

  //   if (!email) {
  //     return res.status(400).json({
  //       success: false,
  //       message: "Email is required",
  //     });
  //   }
    
  //   try {
  //     const user = await this.userModel.findByEmail(email);
  //     if (!user) {
  //       return res.status(404).json({
  //         success: false,
  //         message: "User not found",
  //       });
  //     }
  //     const token = jwt.sign(
  //       { userId: user.id, email: user.email, userType: user.role },
  //       process.env.JWT_SECRET || "default_secret_key",
  //       { expiresIn: "7d" }
  //     );
  //     await this.userModel.updateToken(user.id, token);
  //     await sendMail({
  //       to: user.email,
  //       subject: "Reset Password",
  //       html: `
  //         <div>
  //           <p>Hello,</p>
  //           <p>Click the link below to reset your password:</p>
  //           <a href="${baseUrl}/dashboard/auth/reset-password?token=${token}">Reset Password</a>
  //           <p>If you did not request a password reset, please ignore this email.</p>
  //         </div>
  //       `,
  //     });
  //     return res.status(200).json({
  //       success: true,
  //       message: "Reset password email sent",
  //     });
  //   } catch (error) {
  //     console.error("Error sending reset password email:", error);
  //     return res.status(500).json({
  //       success: false,
  //       message: "An error occurred while sending the reset password email",
  //     });
  //   }
    
  // }
}

module.exports = AuthController;
