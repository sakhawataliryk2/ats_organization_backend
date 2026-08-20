const { Pool } = require('pg');

class EmailTemplateModel {
  constructor(pool) {
    this.pool = pool;
  }

  // Initialize the table if it doesn't exist
async initTables() {
  const client = await this.pool.connect();
  try {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS email_templates (
          id SERIAL PRIMARY KEY,
          template_name VARCHAR(255) NOT NULL,
          subject VARCHAR(255) NOT NULL,
          body TEXT NOT NULL,
          type VARCHAR(50) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await client.query(createTableQuery);

    await client.query(`
      ALTER TABLE email_templates
      ALTER COLUMN type TYPE VARCHAR(80);
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS email_templates_type_unique
      ON email_templates(type);
    `);
 
    console.log("Email templates table initialized + upgraded.");
  } catch (err) {
    console.error("Error initializing email_templates table:", err);
    throw err;
  } finally {
    client.release();
  }
}


  // Create a new email template
  async createTemplate({ template_name, subject, body, type }) {
    const client = await this.pool.connect();
    try {
      const query = `
        INSERT INTO email_templates (template_name, subject, body, type)
        VALUES ($1, $2, $3, $4)
        RETURNING *;
      `;
      const values = [template_name, subject, body, type];
      const res = await client.query(query, values);
      return res.rows[0];
    } finally {
      client.release();
    }
  }

async getTemplateByType(type) {
  const client = await this.pool.connect();
  try {
    const query = `SELECT * FROM email_templates WHERE type = $1 ORDER BY id DESC LIMIT 1;`;
    const res = await client.query(query, [type]);
    return res.rows[0] || null;
  } finally {
    client.release();
  }

}

  // List all templates
  async getAllTemplates() {
    const client = await this.pool.connect();
    try {
      const query = `SELECT * FROM email_templates ORDER BY id ASC;`;
      const res = await client.query(query);
      return res.rows;
    } finally {
      client.release();
    }
  }

  // Get template by ID
  async getTemplateById(id) {
    const client = await this.pool.connect();
    try {
      const query = `SELECT * FROM email_templates WHERE id = $1;`;
      const res = await client.query(query, [id]);
      return res.rows[0];
    } finally {
      client.release();
    }
  }

  // Update template by ID
  async updateTemplateById({ id, template_name, subject, body, type }) {
    const client = await this.pool.connect();
    try {
      const query = `
        UPDATE email_templates
        SET template_name = $1, subject = $2, body = $3, type = $4, updated_at = CURRENT_TIMESTAMP
        WHERE id = $5
        RETURNING *;
      `;
      const values = [template_name, subject, body, type, id];
      const res = await client.query(query, values);
      return res.rows[0];
    } finally {
      client.release();
    }
  }

  // Delete template by ID
  async deleteTemplateById(id) {
    const client = await this.pool.connect();
    try {
      const query = `DELETE FROM email_templates WHERE id = $1 RETURNING *;`;
      const res = await client.query(query, [id]);
      return res.rows[0];
    } finally {
      client.release();
    }
  }
}

module.exports = EmailTemplateModel;