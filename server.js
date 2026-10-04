const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { db, save, hashPassword, makeToken, makeUid } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

const MODS_DIR = path.join(__dirname, "mods");
const PUBLIC_DIR = path.join(__dirname, "public");
const BASE_URL =
  process.env.BASE_URL || "https://twilight-dlc-server.onrender.com";

// ------------------------------------------------------------------
// Middleware
// ------------------------------------------------------------------
app.use(express.json({ limit: "5mb" }));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.static(PUBLIC_DIR));

// ------------------------------------------------------------------
// Утилиты
// ------------------------------------------------------------------
function offlinePlayerId(name) {
  const hash = crypto
    .createHash("md5")
    .update(`OfflinePlayer:${name}`, "utf8")
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uuidNoDashes(name) {
  return offlinePlayerId(name).replace(/-/g, "");
}

// ------------------------------------------------------------------
// Профиль сборки
// ------------------------------------------------------------------
app.get("/minecraft/api/v1/profile", (req, res) => {
  fs.readFile(path.join(__dirname, "profile.json"), "utf8", (err, data) => {
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
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }
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

app.post("/api/auth/register", (req, res) => {
  const { nick, password } = req.body || {};
  if (!nick || !password)
    return res.status(400).json({ error: "nick и password обязательны" });
  if (!/^[A-Za-z0-9_]{3,16}$/.test(nick))
    return res.status(400).json({ error: "Ник: 3–16 символов" });
  if (password.length < 6)
    return res.status(400).json({ error: "Пароль минимум 6 символов" });
  const key = nick.toLowerCase();
  if (db.users[key]) return res.status(409).json({ error: "Ник уже занят" });
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
  res.json({
    token,
    user: { nick, uid: user.uid, bio: "", plan: "Free", skin: null },
  });
});

app.post("/api/auth/login", (req, res) => {
  const { nick, password } = req.body || {};
  if (!nick || !password)
    return res.status(400).json({ error: "nick и password обязательны" });
  const key = nick.toLowerCase();
  const user = db.users[key];
  if (!user) return res.status(401).json({ error: "Неверный ник или пароль" });
  if (hashPassword(user.salt, password) !== user.hash)
    return res.status(401).json({ error: "Неверный ник или пароль" });
  const token = makeToken();
  db.sessions[token] = { nick: key, created: Date.now() };
  save();
  res.json({
    token,
    user: {
      nick: user.nick,
      uid: user.uid,
      bio: user.bio,
      plan: user.plan,
      skin: user.skin,
    },
  });
});

app.get("/api/auth/me", authMiddleware, (req, res) => {
  const u = req.user;
  res.json({
    nick: u.nick,
    uid: u.uid,
    bio: u.bio,
    plan: u.plan,
    skin: u.skin,
  });
});

app.put("/api/auth/profile", authMiddleware, (req, res) => {
  const { bio, skin } = req.body || {};
  if (typeof bio === "string") req.user.bio = bio.slice(0, 160);
  if (typeof skin === "string" || skin === null) req.user.skin = skin;
  save();
  res.json({ ok: true, bio: req.user.bio, skin: req.user.skin });
});

app.post("/api/auth/logout", authMiddleware, (req, res) => {
  delete db.sessions[req.token];
  save();
  res.json({ ok: true });
});

// ------------------------------------------------------------------
// Раздача скина как PNG
// ------------------------------------------------------------------
app.get("/api/skins/:nick", (req, res) => {
  const nick = String(req.params.nick).toLowerCase();
  const user = db.users[nick];
  if (!user || !user.skin) return res.status(404).send("No skin");
  const m = /^data:image\/png;base64,(.+)$/.exec(user.skin);
  if (!m) return res.status(500).send("Bad skin format");
  const buf = Buffer.from(m[1], "base64");
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "no-cache");
  res.send(buf);
});

// ------------------------------------------------------------------
// LAUNCHER FLOW
// ------------------------------------------------------------------
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

app.post("/api/launcher/approve", authMiddleware, (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: "code обязателен" });
  db.launcherCodes[code] = {
    nick: req.user.nick.toLowerCase(),
    token: req.token,
    expiresAt: Date.now() + 5 * 60 * 1000,
  };
  save();
  res.json({ ok: true });
});

app.get("/launcher", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "launcher.html"));
});

// ------------------------------------------------------------------
// YGGDRASIL API
// ------------------------------------------------------------------
app.get("/api/yggdrasil", (req, res) => {
  res.json({
    meta: {
      serverName: "twilightDLC",
      implementationName: "twilightDLC-skin-server",
      implementationVersion: "1.0.0",
    },
    skinDomains: [new URL(BASE_URL).hostname],
    signaturePublickey: "",
  });
});

// Профиль по UUID (authlib-injector запрашивает это для каждого игрока)
app.get(
  "/api/yggdrasil/sessionserver/session/minecraft/profile/:uuid",
  (req, res) => {
    const uuid = String(req.params.uuid).replace(/-/g, "").toLowerCase();
    const userEntry = Object.values(db.users).find(
      (u) => uuidNoDashes(u.nick) === uuid
    );
    if (!userEntry) {
      return res.status(204).end();
    }

    const hasSkin = !!userEntry.skin;
    const textures = {
      timestamp: Date.now(),
      profileId: uuidNoDashes(userEntry.nick),
      profileName: userEntry.nick,
      textures: hasSkin
        ? {
            SKIN: {
              url: `${BASE_URL}/api/skins/${encodeURIComponent(userEntry.nick)}`,
            },
          }
        : {},
    };

    const value = Buffer.from(JSON.stringify(textures)).toString("base64");

    res.json({
      id: uuidNoDashes(userEntry.nick),
      name: userEntry.nick,
      properties: [{ name: "textures", value, signature: "" }],
    });
  }
);

// Заглушки для мультиплеера (чтобы клиент не падал)
app.post(
  "/api/yggdrasil/sessionserver/session/minecraft/join",
  (req, res) => {
    res.status(204).end();
  }
);

app.get(
  "/api/yggdrasil/sessionserver/session/minecraft/hasJoined",
  (req, res) => {
    res.json(null);
  }
);

// Аутентификация (для мультиплеера в будущем)
app.post("/api/yggdrasil/authserver/authenticate", (req, res) => {
  res.status(403).json({ error: "ForbiddenOperationException" });
});

// ------------------------------------------------------------------
// Запуск
// ------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`BASE_URL: ${BASE_URL}`);
  console.log(`Mods dir: ${MODS_DIR}`);
  console.log(`Public dir: ${PUBLIC_DIR}`);
});