const express = require('express');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
const cors = require('cors');
require('dotenv').config();
const helmet = require('helmet');
const compression = require('compression');

// Import custom modules
const { createPool, testDatabaseConnection } = require('./config/database');
const AuthController = require('./controllers/authController');
const OrganizationController = require('./controllers/organizationController');
const JobController = require('./controllers/jobController');
const JobSeekerController = require('./controllers/jobSeekerController');
const HiringManagerController = require('./controllers/hiringManagerController');
const CustomFieldController = require('./controllers/customFieldController');
const createAuthRouter = require('./routes/authRoutes');
const createOrganizationRouter = require('./routes/organizationRoutes');
const createJobRouter = require('./routes/jobRoutes');
const createJobSeekerRouter = require('./routes/jobSeekerRoutes');
const createHiringManagerRouter = require('./routes/hiringManagerRoutes');
const createCustomFieldRouter = require('./routes/customFieldRoutes');
const { notFound, errorHandler } = require('./middleware/errorMiddleware');
const { sanitizeInputs } = require('./middleware/validationMiddleware');
const { verifyToken, checkRole } = require('./middleware/authMiddleware');
const UserController = require('./controllers/userController');
const createUserRouter = require('./routes/userRoutes');
const LeadController = require('./controllers/leadController');
const createLeadRouter = require('./routes/leadRoutes');
const TaskController = require('./controllers/taskController');
const createTaskRouter = require('./routes/taskRoutes');


// Create Express app
const app = express();
const port = process.env.PORT || 8080;

// Security headers
app.use(helmet());

// Compression to reduce payload size
app.use(compression());

// Enable CORS with specific options
app.use(cors({
  // origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  // methods: ['GET', 'POST', 'PUT', 'DELETE'],
  // allowedHeaders: ['Content-Type', 'Authorization']
}));

// Parse request bodies with increased limits
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: false, limit: '1mb' }));

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// Create database pool - lazy initialization for serverless
let pool;
const getPool = () => {
  if (!pool) {
    pool = createPool();
  }
  return pool;
};

// Initialize controllers with lazy DB connection
const getAuthController = () => {
  return new AuthController(getPool());
};

const getHiringManagerController = () => {
  return new HiringManagerController(getPool());
};

const getOrganizationController = () => {
  return new OrganizationController(getPool());
};

const getJobController = () => {
  return new JobController(getPool());
};

// Add this with other controller getters
const getUserController = () => {
  return new UserController(getPool());
};

const getJobSeekerController = () => {
  return new JobSeekerController(getPool());
};

const getCustomFieldController = () => {
  return new CustomFieldController(getPool());
};


// Add this with other controller getters
const getLeadController = () => {
  return new LeadController(getPool());
};


const getTaskController = () => {
  return new TaskController(getPool());
};

// Setup nodemailer with a connection pool
const transporter = nodemailer.createTransport({
  pool: true,
  maxConnections: 5, // Reduced for serverless environment
  maxMessages: 100, // Limit for serverless
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});





app.use(async (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    try {
      const authController = getAuthController();
      await authController.initTables();

      // Initialize organization tables
      if (req.path.startsWith('/api/organizations')) {
        const organizationController = getOrganizationController();
        await organizationController.initTables();
      }

      // Initialize hiring manager tables
      if (req.path.startsWith('/api/hiring-managers')) {
        const hiringManagerController = getHiringManagerController();
        await hiringManagerController.initTables();
      }

      // Initialize job tables
      if (req.path.startsWith('/api/jobs')) {
        const jobController = getJobController();
        await jobController.initTables();
      }

      // Initialize job seeker tables
      if (req.path.startsWith('/api/job-seekers')) {
        const jobSeekerController = getJobSeekerController();
        await jobSeekerController.initTables();
      }

      // Initialize custom field tables
      if (req.path.startsWith('/api/custom-fields')) {
        const customFieldController = getCustomFieldController();
        await customFieldController.initTables();
      }

      // 👇 ADD THIS SECTION RIGHT HERE 👇
      // Initialize lead tables
      if (req.path.startsWith('/api/leads')) {
        const leadController = getLeadController();
        await leadController.initTables();
      }

      // Initialize task tables
      if (req.path.startsWith('/api/tasks')) {
        const taskController = getTaskController();
        await taskController.initTables();
      }
      // 👆 ADD THE ABOVE SECTION HERE 👆

    } catch (error) {
      console.error('Failed to initialize tables:', error.message);
      // Continue anyway - tables might already exist
    }
  }
  next();
});

// Setup routes with lazy controller initialization
app.use('/api/auth', sanitizeInputs, (req, res, next) => {
  const router = createAuthRouter(getAuthController());
  router(req, res, next);
});


app.use('/api/users', sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createUserRouter(getUserController(), authMiddleware);
  router(req, res, next);
});

// Setup organization routes with authentication
app.use('/api/organizations', sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createOrganizationRouter(getOrganizationController(), authMiddleware);
  router(req, res, next);
});

// Setup job routes with authentication
app.use('/api/jobs', sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createJobRouter(getJobController(), authMiddleware);
  router(req, res, next);
});

// Setup job seeker routes with authentication
app.use('/api/job-seekers', sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createJobSeekerRouter(getJobSeekerController(), authMiddleware);
  router(req, res, next);
});

// Setup hiring manager routes with authentication
app.use('/api/hiring-managers', sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createHiringManagerRouter(getHiringManagerController(), authMiddleware);
  router(req, res, next);
});

// Setup custom field routes with authentication
app.use('/api/custom-fields', sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createCustomFieldRouter(getCustomFieldController(), authMiddleware);
  router(req, res, next);
});



app.use('/api/leads', sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createLeadRouter(getLeadController(), authMiddleware);
  router(req, res, next);
});

app.use('/api/tasks', sanitizeInputs, (req, res, next) => {
  const authMiddleware = { verifyToken: verifyToken(getPool()), checkRole };
  const router = createTaskRouter(getTaskController(), authMiddleware);
  router(req, res, next);
});



// Database connection test
app.get('/test-db', async (req, res) => {
  try {
    const pool = getPool();
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT NOW()');
      res.json({ success: true, time: result.rows[0].now });
    } finally {
      client.release(); // Always release the client back to the pool
    }
  } catch (err) {
    console.error('Database query error:', err);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// Add 404 middleware
app.use(notFound);

// Error handling middleware
app.use(errorHandler);

// For local development
if (process.env.NODE_ENV !== 'production') {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

// Export for serverless
module.exports = app;