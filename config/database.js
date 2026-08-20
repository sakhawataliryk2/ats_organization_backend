const { Pool } = require("pg");

// Create a connection pool with settings optimized for serverless
const createPool = () => {
  console.log("Initializing database connection pool...");

  const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_DATABASE,
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
    max: parseInt(process.env.DB_POOL_MAX, 10) || 5, // Keep low to avoid "connection slots reserved for SUPERUSER" on limited DB plans
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT) || 30000, // Reduced for serverless
    connectionTimeoutMillis:
      parseInt(process.env.DB_CONNECTION_TIMEOUT) || 60000, // 60s for long ops (e.g. archive cascade)
    maxUses: 7500,
  });

  // Handle pool errors
  pool.on("error", (err, client) => {
    console.error("Unexpected error on idle client", err);
  });

  return pool;
};

// Function to test database connection
const testDatabaseConnection = async (pool) => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query("SELECT NOW()");
      console.log("✅ Database connection successful:", result.rows[0].now);
      return true;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("❌ Database connection failed:", error.message);
    console.error(
      "Please check your database credentials and ensure PostgreSQL is running."
    );
    return false;
  }
};

module.exports = { createPool, testDatabaseConnection };
