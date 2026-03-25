// Lazy-initialized pool for serverless and long-running server use.
const { createPool } = require("./database");

let pool;

function getPool() {
  if (!pool) {
    pool = createPool();
  }
  return pool;
}

module.exports = { getPool };
