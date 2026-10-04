const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { db, save, hashPassword, makeToken, makeCode, makeUid } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

const MODS_DIR = path.join(__dirname, "mods");
const PUBLIC_DIR = path.join(__dirname, "public");

// ------------------------------------------------------------------
// Middleware
// ------------------------------------------------------------------
app.use(express.json({ limit: "5mb" }));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ------------------------------------------------------------------
// Статика: сайт
// ------------------------------------------------------------------
app.use(express.static(PUBLIC_DIR));

// ------------------------------------------------------------------
// Профиль сборки (для лаунчера)
// ------------------------------------------------------------------
app.get("/minecraft/api/v1/profile", (req, res) => {
  const profilePath = path.join(__dirname, "profile.json");
  fs.readFile(profilePath, "utf8", (err, data) => {
    if (err) return res.status(404).json({ error: "Profile not found" });
    res.json(JSON.parse(data));
  });
});

// ------------------------------------------------------------------
// Манифест модов
// ------------------------------------------------------------------
function sha1File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha1");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (c) => hash.update(c));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function walkMods(dir, base = dir) {
  const result = {};
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(result, await walkMods(full, base));
    } else if (entry.isFile()) {
      const rel = path.relative(base, full).split(path.sep).join("/");
      const key = `mods/${rel}`;
      const stat = await fs.promises.stat(full);
      result[key] = { sha1: await sha1File(full), size: stat.size };
    }
  }
  return result;
}

app.get("/minecraft/api/v1/manifest", async (req, res) => {
  try {
    if (!fs.existsSync(MODS_DIR)) return res.json({ files: {} });
    res.json({ files: await walkMods(MODS_DIR) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Manifest failed" });
  }
});

app.get("/minecraft/api/v1/files/mods/:name", (req, res) => {
  const name = req.params.name;
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    return res.status(400).json({ error: "Invalid file" });
  }
  const filePath = path.join(MODS_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });
  res.sendFile(filePath);
});

// ------------------------------------------------------------------
// AUTH API
// ------------------------------------------------------------------

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const session = db.sessions[token];
  if (!session) return res.status(401).json({ error: "Unauthorized" });
  const user = db.users[session.nick];
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  req.user = user;
  req.token = token;
  next();
}

// Регистрация
app.post("/api/auth/register", (req, res) => {
  const { nick, password } = req.body || {};
  if (!nick || !password) return res.status(400).json({ error: "nick и password обязательны" });
  if (!/^[A-Za-z0-9_]{3,16}$/.test(nick)) {
    return res.status(400).json({ error: "Ник: 3–16 символов, латиница, цифры и _" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Пароль минимум 6 символов" });
  }
  const key = nick.toLowerCase();
  if (db.users[key]) {
    return res.status(409).json({ error: "Ник уже занят" });
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const user = {
    nick,
    salt,
    hash: hashPassword(salt, password),
    uid: makeUid(),
    bio: "",
    plan: "Free",
    skin: null,
    created: Date.now(),
  };
  db.users[key] = user;
  const token = makeToken();
  db.sessions[token] = { nick: key, created: Date.now() };
  save();
  res.json({ token, user: { nick, uid: user.uid, bio: "", plan: "Free", skin: null } });
});

// Логин
app.post("/api/auth/login", (req, res) => {
  const { nick, password } = req.body || {};
  if (!nick || !password) return res.status(400).json({ error: "nick и password обязательны" });
  const key = nick.toLowerCase();
  const user = db.users[key];
  if (!user) return res.status(401).json({ error: "Неверный ник или пароль" });
  if (hashPassword(user.salt, password) !== user.hash) {
    return res.status(401).json({ error: "Неверный ник или пароль" });
  }
  const token = makeToken();
  db.sessions[token] = { nick: key, created: Date.now() };
  save();
  res.json({ token, user: { nick: user.nick, uid: user.uid, bio: user.bio, plan: user.plan, skin: user.skin } });
});

// Проверка сессии
app.get("/api/auth/me", authMiddleware, (req, res) => {
  const u = req.user;
  res.json({ nick: u.nick, uid: u.uid, bio: u.bio, plan: u.plan, skin: u.skin });
});

// Обновить профиль (bio, skin)
app.put("/api/auth/profile", authMiddleware, (req, res) => {
  const { bio, skin } = req.body || {};
  if (typeof bio === "string") req.user.bio = bio.slice(0, 160);
  if (typeof skin === "string" || skin === null) req.user.skin = skin;
  save();
  res.json({ ok: true, bio: req.user.bio, skin: req.user.skin });
});

// Выход
app.post("/api/auth/logout", authMiddleware, (req, res) => {
  delete db.sessions[req.token];
  save();
  res.json({ ok: true });
});

// ------------------------------------------------------------------
// LAUNCHER AUTH FLOW
// ------------------------------------------------------------------

// Проверка статуса code (вызывает лаунчер)
app.get("/api/launcher/status", (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).json({ error: "code обязателен" });

  const entry = db.launcherCodes[code];
  if (!entry) return res.json({ status: "pending" });

  if (Date.now() > entry.expiresAt) {
    delete db.launcherCodes[code];
    save();
    return res.json({ status: "expired" });
  }

  const user = db.users[entry.nick];
  delete db.launcherCodes[code];
  save();

  res.json({
    status: "approved",
    token: entry.token,
    user: {
      nick: user.nick,
      uid: user.uid,
      plan: user.plan,
      skin: user.skin,
    },
  });
});

// Игрок нажал «Разрешить» на сайте
app.post("/api/launcher/approve", authMiddleware, (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: "code обязателен" });

  // Продлеваем сессию на минуту — достаточно для передачи в лаунчер
  db.launcherCodes[code] = {
    nick: req.user.nick.toLowerCase(),
    token: req.token,
    expiresAt: Date.now() + 5 * 60 * 1000,
  };
  save();
  res.json({ ok: true });
});

// ------------------------------------------------------------------
// Страница /launcher
// ------------------------------------------------------------------
app.get("/launcher", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "launcher.html"));
});

// ------------------------------------------------------------------
// Запуск
// ------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Mods dir: ${MODS_DIR}`);
  console.log(`Public dir: ${PUBLIC_DIR}`);
});