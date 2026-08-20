const express = require("express");
const nodemailer = require("nodemailer");
const bodyParser = require("body-parser");
const cors = require("cors");
require("dotenv").config();
const helmet = require("helmet");
const compression = require("compression");
const path = require("path");

// Check for required environment variables (only in production)
if (process.env.NODE_ENV === 'production') {
  const requiredEnvVars = ['JWT_SECRET', 'DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_DATABASE'];
  const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

  if (missingEnvVars.length > 0) {
    console.error('❌ Missing required environment variables:', missingEnvVars.join(', '));
    console.error('Please ensure all required environment variables are set in your Vercel deployment.');
    // Don't exit in production, just log the error
    console.error('Continuing with deployment but some features may not work properly.');
  }
}

// Import custom modules
const { createPool, testDatabaseConnection } = require("./config/database");
const { getPool } = require("./config/getPool");
const AuthController = require("./controllers/authController");
const OrganizationController = require("./controllers/organizationController");
const JobController = require("./controllers/jobController");
const JobSeekerController = require("./controllers/jobSeekerController");
const ClientSubmissionController = require("./controllers/clientSubmissionController");
const HiringManagerController = require("./controllers/hiringManagerController");
const CustomFieldController = require("./controllers/customFieldController");
const UserController = require("./controllers/userController");
const LeadController = require("./controllers/leadController");
const TaskController = require("./controllers/taskController");
const PlacementController = require("./controllers/placementController");
const TearsheetController = require("./controllers/tearsheetController");
const AdminDocumentController = require("./controllers/adminDocumentController");
const TransferController = require("./controllers/transferController");
const HiringManagerTransferController = require("./controllers/hiringManagerTransferController");
const JobSeekerTransferController = require("./controllers/jobSeekerTransferController");
const DeleteRequestController = require("./controllers/deleteRequestController");
const SharedDocumentController = require("./controllers/sharedDocumentController");
const BroadcastMessageController = require("./controllers/broadcastMessageController");
const HeaderConfigController = require("./controllers/headerConfigController");
const JobXMLController = require("./controllers/jobsXMLController");
const AppointmentController = require("./controllers/appointmentController");
const ZoomPhoneController = require("./controllers/zoomPhoneController");
const CallController = require("./controllers/callController");
// NEW IMPORTS
const OfficeController = require("./controllers/officeController");
const TeamController = require("./controllers/teamController");
const TemplateDocumentController = require("./controllers/templateDocumentController");
const ActivityController = require("./controllers/activityController");
//OnBoarding
const OnboardingController = require("./controllers/onboardingController");
const createOnboardingRouter = require("./routes/onboardingRoutes");

const createAuthRouter = require("./routes/authRoutes");
const { createOrganizationRouter, createTransferRouter, createDeleteRequestRouter } = require("./routes/organizationRoutes");
const { createUnarchiveRequestRouter } = require("./routes/unarchiveRequestRoutes");
const { createJobRouter, createJobDeleteRequestRouter } = require("./routes/jobRoutes");
const createJobXMLRouter = require("./routes/jobXMLRoutes");
const jobSeekerRoutes = require("./routes/jobSeekerRoutes");
const createJobSeekerRouter = jobSeekerRoutes.default ?? jobSeekerRoutes;
const createJobSeekerDeleteRequestRouter = jobSeekerRoutes.createJobSeekerDeleteRequestRouter;
const createHiringManagerRouter = require("./routes/hiringManagerRoutes");
const createHiringManagerTransferRouter = require("./routes/hiringManagerTransferRoutes");
const createJobSeekerTransferRouter = require("./routes/jobSeekerTransferRoutes");
const createCustomFieldRouter = require("./routes/customFieldRoutes");
const createUserRouter = require("./routes/userRoutes");
const { createLeadRouter, createLeadDeleteRequestRouter } = require("./routes/leadRoutes");
const { createTaskRouter, createTaskDeleteRequestRouter } = require("./routes/taskRoutes");
const { createPlacementRouter, createPlacementDeleteRequestRouter } = require("./routes/placementRoutes");
const createTearsheetRouter = require("./routes/tearsheetRoutes");
const createAdminDocumentRouter = require("./routes/adminDocumentRoutes");
const createSharedDocumentRouter = require("./routes/sharedDocumentRoutes");
const createBroadcastMessageRouter = require("./routes/broadcastMessageRoutes");
const createHeaderConfigRouter = require("./routes/headerConfigRoutes");
const { createAppointmentRouter, createZoomWebhookRouter } = require("./routes/appointmentRoutes");
const { createZoomPhoneRouter, createZoomPhoneWebhookRouter } = require("./routes/zoomPhoneRoutes");
const { createZoomRouter } = require("./routes/zoomRoutes");
const { createCallRouter } = require("./routes/callRoutes");
// NEW ROUTE IMPORTS
const createOfficeRouter = require("./routes/officeRoutes");
const createTeamRouter = require("./routes/teamRoutes");
const createTemplateDocumentsRouter = require("./routes/templateDocumentsRoutes");
const createOrganizationDefaultDocumentRouter = require("./routes/organizationDefaultDocumentRoutes");
const createScrapeRouter = require("./routes/scrapeRoutes");
const createActivityRouter = require("./routes/activityRoutes");
const AnalyticsController = require("./controllers/analyticsController");
const createAnalyticsRouter = require("./routes/analyticsRoutes");
const RecordNumberController = require("./controllers/recordNumberController");
const createRecordNumberRouter = require("./routes/recordNumberRoutes");

const packetRoutes = require("./routes/packetRoutes");

// Job Sekker Portal
const jobseekerPortalAuthRoutes = require("./routes/jobseekerPortalAuthRoutes");
const jobseekerPortalDocumentsRoutes = require("./routes/jobseekerPortalDocumentsRoutes");
const jobseekerPortalTimecardsRoutes = require("./routes/jobseekerPortalTimecardsRoutes");
const jobseekerPortalTasksRoutes = require("./routes/jobseekerPortalTasksRoutes");

// Email Template
const EmailTemplateController = require("./controllers/emailTemplateController");

const { notFound, errorHandler } = require("./middleware/errorMiddleware");
const { sanitizeInputs } = require("./middleware/validationMiddleware");
const { createZoomWebhookStack } = require("./webhooks/zoomWebhook");
const { verifyToken, checkRole } = require("./middleware/authMiddleware");
const createEmailTemplateRouter = require("./routes/emailTemplateRoutes");


// Create Express app
const app = express();
const port = process.env.PORT || 8080;

// Security headers
app.use(helmet());

// Compression to reduce payload size
app.use(compression());

// Enable CORS with specifi
const allowedOrigins = [
  'http://localhost:3000',   // Local development
  'http://localhost:8081',   // Expo / React Native web
  'http://localhost:19006',  // Expo web dev server
  'http://localhost:19000',  // Expo dev server
  'https://ats-orcin.vercel.app',  // Production
  'https://ats-software-frontend.vercel.app',
  'https://cms-organization-phi.vercel.app',
  'http://192.168.100.36:8081'
];

// Use environment variable for additional origins if needed
const additionalOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : [];

const allOrigins = [...allowedOrigins, ...additionalOrigins];

try {
  app.use(
    cors({
      origin: process.env.NODE_ENV === "production" ? allOrigins : true,
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
      credentials: true,
    })
  );
} catch (error) {
  console.error("CORS configuration error:", error);
  // Fallback to basic CORS
  app.use(cors());
}

// Normalize URLs with double leading slashes (e.g. `//webhooks/zoom`).
// This prevents Express from failing to match routes.
app.use((req, res, next) => {
  if (req.url && /^\/{2,}/.test(req.url)) {
    req.url = req.url.replace(/^\/{2,}/, "/");
  }
  return next();
});

// Note: Zoom webhook needs raw body for signature verification — skip JSON parse for that path
app.use((req, res, next) => {
  if (req.method === "POST" && req.path === "/webhooks/zoom") return next();
  const isJobsImport = req.method === "POST" && req.path === "/api/jobs/import";
  return bodyParser.json({ limit: isJobsImport ? "50mb" : "1mb" })(req, res, next);
});
app.use(bodyParser.urlencoded({ extended: false, limit: "1mb" }));
app.use(
  "/uploads",
  cors({
    origin: true,
    credentials: true,
  }),
  (req, res, next) => {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    next();
  },
  express.static(path.join(process.cwd(), "uploads"), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".pdf")) {
        res.setHeader("Content-Type", "application/pdf");
      }
    },
  })
);

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(
      `${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`
    );
  });
  next();
});

// Initialize controllers with lazy DB connection
const getAuthController = () => {
  return new AuthController(getPool());
};

const getJobXMLController = () => {
  return new JobXMLController(getPool());
};

const getHiringManagerController = () => {
  return new HiringManagerController(getPool());
};

const getOrganizationController = () => {
  return new OrganizationController(getPool());
};

const getTransferController = () => {
  return new TransferController(getPool());
};
const getHiringManagerTransferController = () => {
  return new HiringManagerTransferController(getPool());
};

const getJobSeekerTransferController = () => {
  return new JobSeekerTransferController(getPool());
};

const getDeleteRequestController = () => {
  return new DeleteRequestController(getPool());
};

const getJobController = () => {
  return new JobController(getPool());
};

const getUserController = () => {
  return new UserController(getPool());
};

const getJobSeekerController = () => {
  return new JobSeekerController(getPool());
};

const getClientSubmissionController = () => {
  return new ClientSubmissionController(getPool());
};

const getCustomFieldController = () => {
  return new CustomFieldController(getPool());
};

const getLeadController = () => {
  return new LeadController(getPool());
};

const getTaskController = () => {
  return new TaskController(getPool());
};

const getPlacementController = () => {
  return new PlacementController(getPool());
};

const getTearsheetController = () => {
  return new TearsheetController(getPool());
};

const getAdminDocumentController = () => {
  return new AdminDocumentController(getPool());
};

const getSharedDocumentController = () => {
  return new SharedDocumentController(getPool());
};

const getBroadcastMessageController = () => {
  return new BroadcastMessageController(getPool());
};

const getHeaderConfigController = () => {
  return new HeaderConfigController(getPool());
};

// NEW CONTROLLER GETTERS
const getOfficeController = () => {
  return new OfficeController(getPool());
};

const getTeamController = () => {
  return new TeamController(getPool());
};
//OnBooarding
const getOnboardingController = () => {
  return new OnboardingController(getPool());
};
const getEmailTemplateController = () => {
  return new EmailTemplateController(getPool());
};

const getAppointmentController = () => {
  return new AppointmentController(getPool());
};

const getZoomPhoneController = () => {
  return new ZoomPhoneController(getPool());
};

const getCallController = () => {
  return new CallController(getPool());
};

const getActivityController = () => {
  return new ActivityController(getPool());
};

const getAnalyticsController = () => {
  return new AnalyticsController(getPool());
};

const getRecordNumberController = () => {
  return new RecordNumberController(getPool());
};

// Core tables (offices, teams, users) initialized once at startup to avoid connection exhaustion
let coreTablesInitialized = false;
let coreTablesInitPromise = null;

app.use(async (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    try {
      // Initialize core tables once per process (not on every request)
      if (!coreTablesInitialized) {
        if (!coreTablesInitPromise) {
          coreTablesInitPromise = (async () => {
            const officeController = getOfficeController();
            await officeController.initTables();
            const teamController = getTeamController();
            await teamController.initTables();
            const authController = getAuthController();
            await authController.initTables();
            try {
              const jobXMLController = getJobXMLController();
              if (jobXMLController && typeof jobXMLController.initTables === 'function') {
                await jobXMLController.initTables();
              } else {
                console.warn('⚠️ jobXMLController.initTables is not available, skipping...');
              }
            } catch (jobXMLError) {
              console.warn('⚠️ Failed to initialize jobXML tables:', jobXMLError.message);
              // Continue anyway
            }
            coreTablesInitialized = true;
            console.log("Core tables (offices, teams, users) initialized.");
          })();
        }
        await coreTablesInitPromise;
      }

      // Initialize organization tables (path-based, only when needed)
      if (req.path.startsWith("/api/organizations")) {
        const organizationController = getOrganizationController();
        await organizationController.initTables();
      }

      // Initialize hiring manager tables
      if (req.path.startsWith("/api/hiring-managers")) {
        try {
          const hiringManagerController = getHiringManagerController();
          await hiringManagerController.initTables();
        } catch (hmError) {
          console.error('❌ Failed to initialize hiring manager tables:', hmError.message);
          console.error('Error stack:', hmError.stack);
          // Don't throw - let the route handle it, but log clearly
        }
      }

      // Initialize job tables
      if (req.path.startsWith("/api/jobs")) {
        const jobController = getJobController();
        await jobController.initTables();
      }

      // Initialize job seeker tables
      if (req.path.startsWith("/api/job-seekers")) {
        const jobSeekerController = getJobSeekerController();
        await jobSeekerController.initTables();
        const clientSubmissionController = getClientSubmissionController();
        await clientSubmissionController.initTables();
      }

      // Initialize custom field tables
      if (req.path.startsWith("/api/custom-fields")) {
        const customFieldController = getCustomFieldController();
        await customFieldController.initTables();
      }

      // Initialize lead tables
      if (req.path.startsWith("/api/leads")) {
        const leadController = getLeadController();
        await leadController.initTables();
      }

      // Initialize task tables
      if (req.path.startsWith("/api/tasks")) {
        const taskController = getTaskController();
        await taskController.initTables();
      }

      // Initialize placement tables (depends on jobs and job_seekers)
      if (req.path.startsWith("/api/placements")) {
        const placementController = getPlacementController();
        await placementController.initTables();
      }

      // Initialize tearsheet tables
      if (req.path.startsWith("/api/tearsheets")) {
        const tearsheetController = getTearsheetController();
        await tearsheetController.initTables();
      }

      // Initialize transfer tables
      if (req.path.startsWith("/api/organizations/transfer")) {
        const transferController = getTransferController();
        await transferController.initTables();
      }
      // Initialize hiring manager transfer table
      if (req.path.startsWith("/api/hiring-managers/transfer")) {
        const HiringManagerTransfer = require("./models/hiringManagerTransfer");
        const hmTransferModel = new HiringManagerTransfer(getPool());
        await hmTransferModel.initTable();
      }
      // Initialize job seeker transfer table
      if (req.path.startsWith("/api/job-seekers/transfer")) {
        const JobSeekerTransfer = require("./models/jobSeekerTransfer");
        const jsTransferModel = new JobSeekerTransfer(getPool());
        await jsTransferModel.initTable();
      }

      // Initialize delete request tables
      if (req.path.includes("/delete-request") ||
          req.path.includes("/unarchive-request") ||
          req.path.match(/\/delete\/\d+/) ||
          req.path.match(/\/delete\/\d+\/(approve|deny)/)) {
        const deleteRequestController = getDeleteRequestController();
        await deleteRequestController.initTables();
      }

      // Initialize admin document tables
      if (req.path.startsWith("/api/admin/documents")) {
        const adminDocumentController = getAdminDocumentController();
        await adminDocumentController.initTables();
      }

      // Initialize shared document tables
      if (req.path.startsWith("/api/shared-documents")) {
        const sharedDocumentController = getSharedDocumentController();
        await sharedDocumentController.initTables();
      }

      // Initialize broadcast message tables
      if (req.path.startsWith("/api/broadcast-messages")) {
        const broadcastMessageController = getBroadcastMessageController();
        await broadcastMessageController.initTables();
      }

      // Initialize header config tables
      if (req.path.startsWith("/api/header-config")) {
        const headerConfigController = getHeaderConfigController();
        await headerConfigController.initTables();
      }
      if (req.path.startsWith("/api/template-documents")) {
        const templateController = new TemplateDocumentController(getPool());
        await templateController.initTables();
      }
      if (req.path.startsWith("/api/packets")) {
        const Packet = require("./models/Packet");
        const packetModel = new Packet(getPool());
        await packetModel.initTable();
      }
      // OnBoarding
      if (req.path.startsWith("/api/onboarding")) {
        const onboardingController = getOnboardingController();
        await onboardingController.initTables();
      }
      // Job Seeker Portal (login tables + timecards)
      if (req.path.startsWith("/api/jobseeker-portal")) {
        const JobseekerPortalAuthController = require("./controllers/jobseekerPortalAuthController");
        const c = new JobseekerPortalAuthController(getPool());
        await c.initTables();

        const Onboarding = require("./models/onboarding");
        const ob = new Onboarding(getPool());
        await ob.initTables();

        const Timecard = require("./models/timecard");
        const tc = new Timecard(getPool());
        await tc.initTable();
      }
      // Initialize email template tables
      if (req.path.startsWith("/api/email-templates")) {
        const emailTemplateController = new EmailTemplateController(getPool());
        await emailTemplateController.initTables();
      }
      // Initialize appointment tables
      if (req.path.startsWith("/api/appointments") || req.path.startsWith("/api/planner/appointments") || req.path.startsWith("/api/zoom")) {
        try {
          const appointmentController = getAppointmentController();
          console.log("🔄 Initializing appointment tables for path:", req.path);
          await appointmentController.initTables();
          console.log("✅ Appointment tables initialization completed for path:", req.path);
        } catch (appointmentError) {
          console.error("❌ Failed to initialize appointment tables:", appointmentError);
          console.error("Error details:", appointmentError.message);
          console.error("Error stack:", appointmentError.stack);
          // Don't throw - let the route handle the error, but log it clearly
        }
      }
      // Initialize activity log tables
      if (req.path.startsWith("/api/activity")) {
        const activityController = getActivityController();
        await activityController.initTables();
      }

      // Initialize analytics tables (sessions, page views, field changes)
      if (req.path.startsWith("/api/analytics")) {
        const analyticsController = getAnalyticsController();
        await analyticsController.initTables();
      }
    } catch (error) {
      console.error("Failed to initialize tables:", error.message);
      // Continue anyway - tables might already exist
    }
  }
  next();
});

// Setup routes with lazy controller initialization
app.use("/api/auth", sanitizeInputs, (req, res, next) => {
  const router = createAuthRouter(getAuthController());
  router(req, res, next);
});

// Setup job XML routes
app.use("/api/jobs/xml", sanitizeInputs, (req, res, next) => {
  const router = createJobXMLRouter(getJobXMLController());
  router(req, res, next);
});

// Activity logging + admin activity endpoints
app.use("/api/activity", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createActivityRouter(getActivityController(), authMiddleware);
  router(req, res, next);
});

// Analytics tracking endpoints
app.use("/api/analytics", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createAnalyticsRouter(getAnalyticsController(), authMiddleware);
  router(req, res, next);
});

// Record number lookup: GET /api/record-number/:module/:id -> { recordNumber }
app.use("/api/record-number", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createRecordNumberRouter(getRecordNumberController(), authMiddleware);
  router(req, res, next);
});

app.use("/api/users", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createUserRouter(getUserController(), authMiddleware);
  router(req, res, next);
});

// Setup delete request routes FIRST (before main routes to avoid conflicts)
const applyDeleteRequestRoutes = (basePath) => {
  app.use(basePath, sanitizeInputs, (req, res, next) => {
    if (req.path.includes("/delete-request") ||
        req.path.includes("/unarchive-request") ||
        req.path.match(/\/delete\/\d+/) ||
        req.path.match(/\/delete\/\d+\/(approve|deny)/)) {
      const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
      const router = createDeleteRequestRouter(
        getDeleteRequestController(),
        authMiddleware
      );
      router(req, res, next);
    } else {
      next();
    }
  });
};

applyDeleteRequestRoutes("/api/organizations");
applyDeleteRequestRoutes("/api/hiring-managers");

// Unarchive request approve/deny (generic; id = unarchive_request id)
app.use("/api/unarchive-requests", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createUnarchiveRequestRouter(
    getDeleteRequestController(),
    authMiddleware
  );
  router(req, res, next);
});
// Job-seekers use dedicated delete router below (same pattern as jobs, leads, tasks, placements)

// Setup organization routes with authentication
app.use("/api/organizations", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createOrganizationRouter(
    getOrganizationController(),
    authMiddleware
  );
  router(req, res, next);
});

// Setup transfer routes with authentication
app.use("/api/organizations/transfer", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createTransferRouter(
    getTransferController(),
    authMiddleware
  );
  router(req, res, next);
});

// Hiring manager transfer routes (must be before /api/hiring-managers so /transfer is matched)
app.use("/api/hiring-managers/transfer", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createHiringManagerTransferRouter(
    getHiringManagerTransferController(),
    authMiddleware
  );
  router(req, res, next);
});

// Setup delete request routes for jobs FIRST (before main routes to avoid conflicts)
app.use("/api/jobs", sanitizeInputs, (req, res, next) => {
  if (req.path.includes("/delete-request") ||
      req.path.includes("/unarchive-request") ||
      req.path.match(/\/delete\/\d+/) ||
      req.path.match(/\/delete\/\d+\/(approve|deny)/)) {
    const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
    const router = createJobDeleteRequestRouter(
      getDeleteRequestController(),
      authMiddleware
    );
    router(req, res, next);
  } else {
    next();
  }
});

// Setup job routes with authentication
app.use("/api/jobs", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createJobRouter(getJobController(), authMiddleware);
  router(req, res, next);
});

// Job seeker transfer routes (must be before /api/job-seekers so /transfer is matched)
app.use("/api/job-seekers/transfer", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createJobSeekerTransferRouter(
    getJobSeekerTransferController(),
    authMiddleware
  );
  router(req, res, next);
});

// Setup delete request routes for job seekers FIRST (same pattern as tasks/jobs)
app.use("/api/job-seekers", sanitizeInputs, (req, res, next) => {
  if (req.path.includes("/delete-request") ||
      req.path.includes("/unarchive-request") ||
      req.path.match(/\/delete\/\d+/) ||
      req.path.match(/\/delete\/\d+\/(approve|deny)/)) {
    const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
    const router = createJobSeekerDeleteRequestRouter(
      getDeleteRequestController(),
      authMiddleware
    );
    router(req, res, next);
  } else {
    next();
  }
});

// Setup job seeker routes with authentication
app.use("/api/job-seekers", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createJobSeekerRouter(
    getJobSeekerController(),
    authMiddleware,
    getClientSubmissionController()
  );
  router(req, res, next);
});

// Setup hiring manager routes with authentication
app.use("/api/hiring-managers", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createHiringManagerRouter(
    getHiringManagerController(),
    authMiddleware
  );
  router(req, res, next);
});

// Setup custom field routes with authentication
app.use("/api/custom-fields", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createCustomFieldRouter(
    getCustomFieldController(),
    authMiddleware
  );
  router(req, res, next);
});

// Setup delete request routes for leads FIRST (before main routes to avoid conflicts)
app.use("/api/leads", sanitizeInputs, (req, res, next) => {
  if (req.path.includes("/delete-request") ||
      req.path.includes("/unarchive-request") ||
      req.path.match(/\/delete\/\d+/) ||
      req.path.match(/\/delete\/\d+\/(approve|deny)/)) {
    const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
    const router = createLeadDeleteRequestRouter(
      getDeleteRequestController(),
      authMiddleware
    );
    router(req, res, next);
  } else {
    next();
  }
});

app.use("/api/leads", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createLeadRouter(getLeadController(), authMiddleware);
  router(req, res, next);
});

// Setup delete request routes for tasks FIRST (before main routes to avoid conflicts)
app.use("/api/tasks", sanitizeInputs, (req, res, next) => {
  if (req.path.includes("/delete-request") ||
      req.path.includes("/unarchive-request") ||
      req.path.match(/\/delete\/\d+/) ||
      req.path.match(/\/delete\/\d+\/(approve|deny)/)) {
    const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
    const router = createTaskDeleteRequestRouter(
      getDeleteRequestController(),
      authMiddleware
    );
    router(req, res, next);
  } else {
    next();
  }
});

app.use("/api/tasks", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createTaskRouter(getTaskController(), authMiddleware);
  router(req, res, next);
});

// Setup delete request routes for placements FIRST (before main routes to avoid conflicts)
app.use("/api/placements", sanitizeInputs, (req, res, next) => {
  if (req.path.includes("/delete-request") ||
      req.path.includes("/unarchive-request") ||
      req.path.match(/\/delete\/\d+/) ||
      req.path.match(/\/delete\/\d+\/(approve|deny)/)) {
    const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
    const router = createPlacementDeleteRequestRouter(
      getDeleteRequestController(),
      authMiddleware
    );
    router(req, res, next);
  } else {
    next();
  }
});

app.use("/api/placements", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createPlacementRouter(getPlacementController(), authMiddleware);
  router(req, res, next);
});

app.use("/api/tearsheets", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createTearsheetRouter(getTearsheetController(), authMiddleware);
  router(req, res, next);
});

app.use("/api/admin/documents", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createAdminDocumentRouter(getAdminDocumentController(), authMiddleware);
  router(req, res, next);
});

app.use("/api/shared-documents", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createSharedDocumentRouter(getSharedDocumentController(), authMiddleware);
  router(req, res, next);
});

app.use("/api/broadcast-messages", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createBroadcastMessageRouter(getBroadcastMessageController(), authMiddleware);
  router(req, res, next);
});

// Setup header config routes with authentication
app.use("/api/header-config", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createHeaderConfigRouter(getHeaderConfigController(), authMiddleware);
  router(req, res, next);
});

// NEW ROUTE SETUPS
app.use("/api/offices", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createOfficeRouter(getOfficeController(), authMiddleware);
  router(req, res, next);
});

app.use("/api/teams", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createTeamRouter(getTeamController(), authMiddleware);
  router(req, res, next);
});
app.use("/api/template-documents", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createTemplateDocumentsRouter(getPool(), authMiddleware);
  router(req, res, next);
});
app.use("/api/organization-default-documents", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createOrganizationDefaultDocumentRouter(getPool(), authMiddleware);
  router(req, res, next);
});
app.use("/api/packets", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = packetRoutes(getPool(), authMiddleware);
  router(req, res, next);
});
//ONbOARDING
app.use("/api/onboarding", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createOnboardingRouter(
    getOnboardingController(),
    authMiddleware
  );
  router(req, res, next);
});
// Jobseeker Portal Auth Routes (pass authMiddleware for admin-set-password)
app.use("/api/jobseeker-portal/auth", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = jobseekerPortalAuthRoutes(getPool(), authMiddleware);
  router(req, res, next);
});

app.use("/api/jobseeker-portal", sanitizeInputs, (req, res, next) => {
  const router = jobseekerPortalDocumentsRoutes(getPool());
  router(req, res, next);
});

app.use("/api/jobseeker-portal", sanitizeInputs, (req, res, next) => {
  const router = jobseekerPortalTimecardsRoutes(getPool());
  router(req, res, next);
});

app.use("/api/jobseeker-portal", sanitizeInputs, (req, res, next) => {
  const router = jobseekerPortalTasksRoutes(getPool());
  router(req, res, next);
});
//Email Template
app.use("/api/email-templates", sanitizeInputs, (req, res, next) => {
  const router = createEmailTemplateRouter(getPool(), getEmailTemplateController());
  router(req, res, next);
});

// Setup appointment routes with authentication
app.use("/api/appointments", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createAppointmentRouter(getAppointmentController(), authMiddleware);
  router(req, res, next);
});

// Setup planner appointment routes (for frontend compatibility)
app.use("/api/planner/appointments", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createAppointmentRouter(getAppointmentController(), authMiddleware);
  router(req, res, next);
});

// Setup Zoom Meeting webhook route first (no auth) so POST /api/zoom/webhook is handled
app.use("/api/zoom", sanitizeInputs, (req, res, next) => {
  const router = createZoomWebhookRouter(getAppointmentController());
  router(req, res, next);
});

// Zoom API routes (phone users, numbers, call logs) - authenticated
app.use("/api/zoom", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createZoomRouter(authMiddleware);
  router(req, res, next);
});

// Setup Zoom Phone routes (authenticated call endpoint)
app.use("/api/zoom/phone", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createZoomPhoneRouter(getZoomPhoneController(), authMiddleware);
  router(req, res, next);
});

// Click-to-call: POST /api/calls/start
app.use("/api/calls", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createCallRouter(getCallController(), authMiddleware);
  router(req, res, next);
});

// Setup Zoom Phone webhook route (no authentication, uses signature verification)
app.use("/api/webhooks/zoom", sanitizeInputs, (req, res, next) => {
  const router = createZoomPhoneWebhookRouter(getZoomPhoneController());
  router(req, res, next);
});

// Public Zoom webhook endpoint for Zoom Phone webhooks (e.g. for ngrok testing)
// This route handles URL validation and all Zoom Phone webhook events.
app.post("/zoom-webhook", sanitizeInputs, (req, res) => {
  const zoomPhoneController = getZoomPhoneController();
  zoomPhoneController.handleWebhook(req, res);
});

// Zoom Phone webhook with raw body for signature verification (POST /webhooks/zoom)
app.post("/webhooks/zoom", ...createZoomWebhookStack(getZoomPhoneController));

// Setup scrape routes with authentication
app.use("/api/scrape", sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createScrapeRouter(getPool());
  router(req, res, next);
});

// Database connection test
app.get("/test-db", async (req, res) => {
  try {
    const pool = getPool();
    const client = await pool.connect();
    try {
      const result = await client.query("SELECT NOW()");
      res.json({ success: true, time: result.rows[0].now });
    } finally {
      client.release(); // Always release the client back to the pool
    }
  } catch (err) {
    console.error("Database query error:", err);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

// Manual appointment table initialization endpoint (for testing)
app.get("/api/appointments/init", async (req, res) => {
  try {
    const appointmentController = getAppointmentController();
    await appointmentController.initTables();
    res.json({ success: true, message: "Appointment tables initialized successfully" });
  } catch (error) {
    console.error("Error initializing appointment tables:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to initialize appointment tables",
      error: error.message 
    });
  }
});

// Cron API routes (same as Vercel serverless; for local testing and if Express handles /api/cron)
const archiveCleanupCron = require("./api/cron/archive-cleanup");
const taskRemindersCron = require("./api/cron/task-reminders");
const deleteRetryCron = require("./api/cron/delete-retry");
app.get("/api/cron/archive-cleanup", archiveCleanupCron);
app.post("/api/cron/archive-cleanup", archiveCleanupCron);
app.get("/api/cron/task-reminders", taskRemindersCron);
app.post("/api/cron/task-reminders", taskRemindersCron);
app.get("/api/cron/delete-retry", deleteRetryCron);
app.post("/api/cron/delete-retry", deleteRetryCron);

// Add 404 middleware
app.use(notFound);

// Error handling middleware
app.use(errorHandler);

// For local development
if (process.env.NODE_ENV !== "production") {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

// Export for serverless
module.exports = app;
