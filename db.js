const { Pool } = require("pg");

const rawUrl = process.env.DATABASE_URL || "";

// Определяем, нужен ли SSL: локальный Postgres — без SSL, облачный — с SSL
const isLocal =
  rawUrl.includes("localhost") ||
  rawUrl.includes("127.0.0.1") ||
  rawUrl.includes("0.0.0.0");

// Убираем sslmode из URL, если он там есть (Aiven иногда кладёт)
const connectionString = rawUrl.replace(/[?&]sslmode=[^&]*/g, "");

const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS friends (
      id SERIAL PRIMARY KEY,
      user_nick TEXT NOT NULL,
      friend_nick TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE (user_nick, friend_nick)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_friends_user
      ON friends (user_nick);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS last_seen (
      nick TEXT PRIMARY KEY,
      last_seen_at BIGINT NOT NULL
    );
  `);

  console.log("Database initialized");
}

module.exports = { pool, initDb };