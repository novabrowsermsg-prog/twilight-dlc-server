const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      nick TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      email_verified BOOLEAN DEFAULT FALSE,
      salt TEXT,
      hash TEXT,
      uid TEXT,
      bio TEXT DEFAULT '',
      plan TEXT DEFAULT 'Free',
      skin TEXT,
      created BIGINT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      nick TEXT,
      created BIGINT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS launcher_codes (
      code TEXT PRIMARY KEY,
      nick TEXT,
      token TEXT,
      expires_at BIGINT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_codes (
      email TEXT PRIMARY KEY,
      code TEXT,
      expires_at BIGINT
    );
  `);

  console.log("Database initialized");
}

module.exports = { pool, initDb };