/**
 * SQLite fallback module for when PostgreSQL connection fails
 * To use this, you need to install SQLite: npm install sqlite3
 */

const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

// Ensure the data directory exists
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
}

// Create or open SQLite database
const dbPath = path.join(dataDir, 'fallback.sqlite');
const db = new sqlite3.Database(dbPath);

// Initialize database with required tables
const initializeTables = () => {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            // Create users table if it doesn't exist
            db.run(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL,
          user_type TEXT NOT NULL CHECK (user_type IN ('candidate', 'recruiter', 'developer', 'admin', 'owner')),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
                if (err) {
                    console.error('Error creating SQLite users table:', err);
                    reject(err);
                } else {
                    console.log('SQLite fallback database initialized');
                    resolve();
                }
            });
        });
    });
};

// User model for SQLite
const createUser = (userData) => {
    const { name, email, password, userType } = userData;

    return new Promise((resolve, reject) => {
        // Check if user exists
        db.get('SELECT * FROM users WHERE email = ?', [email], (err, row) => {
            if (err) {
                reject(err);
                return;
            }

            if (row) {
                reject(new Error('User with this email already exists'));
                return;
            }

            // Insert new user
            const now = new Date().toISOString();
            db.run(
                'INSERT INTO users (name, email, password, user_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
                [name, email, password, userType, now, now],
                function (err) {
                    if (err) {
                        reject(err);
                        return;
                    }

                    resolve({
                        id: this.lastID,
                        name,
                        email,
                        userType,
                        createdAt: now
                    });
                }
            );
        });
    });
};

// Find user by email
const findUserByEmail = (email) => {
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM users WHERE email = ?', [email], (err, row) => {
            if (err) {
                reject(err);
                return;
            }

            resolve(row || null);
        });
    });
};

module.exports = {
    initializeTables,
    createUser,
    findUserByEmail
};