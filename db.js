const { Pool } = require("pg");

const connectionString = (process.env.DATABASE_URL || "").replace(
  /[?&]sslmode=[^&]*/g,
  ""
);

const pool = new Pool({
  connectionString,
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

  // ===== Друзья (принятые) =====
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

  // ===== Запросы в друзья =====
  await pool.query(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id SERIAL PRIMARY KEY,
      from_nick TEXT NOT NULL,
      to_nick TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE (from_nick, to_nick)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_friend_requests_to
      ON friend_requests (to_nick);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_friend_requests_from
      ON friend_requests (from_nick);
  `);

  // ===== Онлайн-статус =====
  await pool.query(`
    CREATE TABLE IF NOT EXISTS last_seen (
      nick TEXT PRIMARY KEY,
      last_seen_at BIGINT NOT NULL
    );
  `);

  console.log("Database initialized");
}

module.exports = { pool, initDb };