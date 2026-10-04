const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DB_FILE = path.join(__dirname, "data.json");

let db = {
  users: {},          // { nick: { nick, salt, hash, uid, bio, plan, skin, created } }
  sessions: {},       // { token: { nick, created } }
  launcherCodes: {},  // { code: { nick, token, expiresAt } }
};

// Загружаем, если есть
try {
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  }
} catch (e) {
  console.error("DB load failed, starting fresh:", e);
}

function save() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function hashPassword(salt, password) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function makeToken() {
  return crypto.randomBytes(32).toString("hex");
}

function makeCode() {
  return crypto.randomBytes(16).toString("hex");
}

function makeUid() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

module.exports = {
  db,
  save,
  hashPassword,
  makeToken,
  makeCode,
  makeUid,
};