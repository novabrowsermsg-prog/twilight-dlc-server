require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pool, initDb } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

const MODS_DIR = path.join(__dirname, "mods");
const PUBLIC_DIR = path.join(__dirname, "public");
const BASE_URL =
  process.env.BASE_URL || "https://twilight-dlc-server.onrender.com";

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL;
const BREVO_SENDER_NAME = "twilightDLC";

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

// ---------- Utils ----------
function hashPassword(salt, password) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}
function makeToken() {
  return crypto.randomBytes(32).toString("hex");
}
function makeCode() {
  return crypto.randomInt(100000, 999999).toString();
}
function makeUid() {
  return String(Math.floor(1000 + Math.random() * 9000));
}
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

// ---------- Brevo ----------
async function sendVerificationEmail(email, code) {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": BREVO_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
      to: [{ email: email }],
      subject: "Подтверждение почты twilightDLC",
      htmlContent: `
        <div style="font-family: sans-serif; background:#1a0f30; color:#f0e6ff; padding:30px; border-radius:12px; max-width:480px;">
          <h2 style="color:#b86ee8; margin:0 0 12px; letter-spacing:1px;">twilightDLC</h2>
          <p style="font-size:14px; color:#c0b0e6;">Ваш код подтверждения:</p>
          <p style="font-size:34px; letter-spacing:10px; font-weight:bold; color:#fff; margin:16px 0;">${code}</p>
          <p style="color:#9a8cc4; font-size:12px; line-height:1.6;">
            Код действует 10 минут.<br>
            Если вы не регистрировались — просто проигнорируйте это письмо.
          </p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Brevo API error: ${res.status} ${err}`);
  }
}

// ---------- Profile ----------
app.get("/minecraft/api/v1/profile", (req, res) => {
  fs.readFile(path.join(__dirname, "profile.json"), "utf8", (err, data) => {
    if (err) return res.status(404).json({ error: "Profile not found" });
    res.json(JSON.parse(data));
  });
});

// ---------- News ----------
app.get("/api/news", (req, res) => {
  const file = path.join(PUBLIC_DIR, "news.json");
  fs.readFile(file, "utf8", (err, data) => {
    if (err) return res.json([]);
    try {
      res.json(JSON.parse(data));
    } catch {
      res.json([]);
    }
  });
});

// ---------- Mods ----------
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
  if (name.includes("..") || name.includes("/") || name.includes("\\"))
    return res.status(400).json({ error: "Invalid file" });
  const filePath = path.join(MODS_DIR, name);
  if (!fs.existsSync(filePath))
    return res.status(404).json({ error: "File not found" });
  res.sendFile(filePath);
});

// ---------- Auth helpers ----------
async function getUser(nick) {
  const r = await pool.query("SELECT * FROM users WHERE nick = $1", [
    nick.toLowerCase(),
  ]);
  return r.rows[0] || null;
}
async function getSession(token) {
  const r = await pool.query("SELECT * FROM sessions WHERE token = $1", [token]);
  return r.rows[0] || null;
}
async function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const session = await getSession(token);
    if (!session) return res.status(401).json({ error: "Unauthorized" });
    const user = await getUser(session.nick);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    req.user = user;
    req.token = token;
    next();
  } catch (e) {
    console.error("auth error:", e);
    res.status(500).json({ error: "Server error" });
  }
}

// ---------- Send code ----------
app.post("/api/auth/send-code", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: "Введите корректный email" });

    const code = makeCode();
    const expiresAt = Date.now() + 10 * 60 * 1000;

    await pool.query(
      `INSERT INTO email_codes (email, code, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET code = $2, expires_at = $3`,
      [email.toLowerCase(), code, expiresAt]
    );

    res.json({ ok: true });

    sendVerificationEmail(email, code)
      .then(() => console.log("Verification code sent to", email))
      .catch((e) => console.error("Background email failed:", e));
  } catch (e) {
    console.error("send-code error:", e);
    if (!res.headersSent) {
      res.status(500).json({ error: "Ошибка сервера" });
    }
  }
});

// ---------- Register ----------
app.post("/api/auth/register", async (req, res) => {
  try {
    const { nick, password, email, code } = req.body || {};
    if (!nick || !password || !email || !code)
      return res.status(400).json({ error: "Все поля обязательны" });
    if (!/^[A-Za-z0-9_]{3,16}$/.test(nick))
      return res
        .status(400)
        .json({ error: "Ник: 3–16 символов, латиница, цифры и _" });
    if (password.length < 6)
      return res.status(400).json({ error: "Пароль минимум 6 символов" });

    const key = nick.toLowerCase();
    const existing = await getUser(key);
    if (existing) return res.status(409).json({ error: "Ник уже занят" });

    const emailRow = await pool.query(
      "SELECT * FROM email_codes WHERE email = $1",
      [email.toLowerCase()]
    );
    const row = emailRow.rows[0];
    if (!row) return res.status(400).json({ error: "Сначала запросите код" });
    if (Date.now() > row.expires_at)
      return res.status(400).json({ error: "Код истёк, запросите новый" });
    if (row.code !== code)
      return res.status(400).json({ error: "Неверный код" });

    await pool.query("DELETE FROM email_codes WHERE email = $1", [
      email.toLowerCase(),
    ]);

    const salt = crypto.randomBytes(16).toString("hex");
    const hash = hashPassword(salt, password);
    const uid = makeUid();
    const now = Date.now();

    await pool.query(
      `INSERT INTO users (nick, email, email_verified, salt, hash, uid, bio, plan, skin, created)
       VALUES ($1, $2, TRUE, $3, $4, $5, '', 'Free', NULL, $6)`,
      [key, email.toLowerCase(), salt, hash, uid, now]
    );

    const token = makeToken();
    await pool.query(
      "INSERT INTO sessions (token, nick, created) VALUES ($1, $2, $3)",
      [token, key, now]
    );

    res.json({
      token,
      user: { nick, uid, bio: "", plan: "Free", skin: null },
    });
  } catch (e) {
    console.error("register error:", e);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// ---------- Login ----------
app.post("/api/auth/login", async (req, res) => {
  try {
    const { nick, password } = req.body || {};
    if (!nick || !password)
      return res.status(400).json({ error: "nick и password обязательны" });

    const user = await getUser(nick);
    if (!user) return res.status(401).json({ error: "Неверный ник или пароль" });
    if (hashPassword(user.salt, password) !== user.hash)
      return res.status(401).json({ error: "Неверный ник или пароль" });

    const token = makeToken();
    await pool.query(
      "INSERT INTO sessions (token, nick, created) VALUES ($1, $2, $3)",
      [token, user.nick, Date.now()]
    );

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
  } catch (e) {
    console.error("login error:", e);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// ---------- Me ----------
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

// ---------- Profile update ----------
app.put("/api/auth/profile", authMiddleware, async (req, res) => {
  try {
    const { bio, skin } = req.body || {};
    if (typeof bio === "string") {
      await pool.query("UPDATE users SET bio = $1 WHERE nick = $2", [
        bio.slice(0, 160),
        req.user.nick,
      ]);
    }
    if (typeof skin === "string" || skin === null) {
      await pool.query("UPDATE users SET skin = $1 WHERE nick = $2", [
        skin,
        req.user.nick,
      ]);
    }
    const updated = await getUser(req.user.nick);
    res.json({ ok: true, bio: updated.bio, skin: updated.skin });
  } catch (e) {
    console.error("profile update error:", e);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// ---------- Logout ----------
app.post("/api/auth/logout", authMiddleware, async (req, res) => {
  await pool.query("DELETE FROM sessions WHERE token = $1", [req.token]);
  res.json({ ok: true });
});

// ============================================================
// FRIENDS
// ============================================================

const ONLINE_WINDOW_MS = 5 * 60 * 1000;

// --- Список друзей ---
app.get("/api/friends", authMiddleware, async (req, res) => {
  try {
    const rows = await pool.query(
      `SELECT
         f.friend_nick AS nick,
         u.uid,
         u.plan,
         u.skin,
         u.bio,
         ls.last_seen_at
       FROM friends f
       LEFT JOIN users u ON u.nick = f.friend_nick
       LEFT JOIN last_seen ls ON ls.nick = f.friend_nick
       WHERE f.user_nick = $1
       ORDER BY ls.last_seen_at DESC NULLS LAST, f.friend_nick ASC`,
      [req.user.nick]
    );

    const now = Date.now();
    const list = rows.rows.map((r) => ({
      nick: r.nick,
      uid: r.uid || r.nick,
      plan: r.plan || "Free",
      skin: r.skin || null,
      bio: r.bio || "",
      online:
        r.last_seen_at != null &&
        now - Number(r.last_seen_at) < ONLINE_WINDOW_MS,
      lastSeen: r.last_seen_at ? Number(r.last_seen_at) : null,
    }));

    res.json(list);
  } catch (e) {
    console.error("GET /api/friends error:", e);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// --- Входящие запросы ---
app.get("/api/friends/requests", authMiddleware, async (req, res) => {
  try {
    const rows = await pool.query(
      `SELECT r.from_nick AS nick, u.uid, u.skin, u.bio, r.created_at
       FROM friend_requests r
       LEFT JOIN users u ON u.nick = r.from_nick
       WHERE r.to_nick = $1
       ORDER BY r.created_at DESC`,
      [req.user.nick]
    );
    res.json(
      rows.rows.map((r) => ({
        nick: r.nick,
        uid: r.uid || r.nick,
        skin: r.skin || null,
        bio: r.bio || "",
        createdAt: Number(r.created_at),
      }))
    );
  } catch (e) {
    console.error("GET /api/friends/requests error:", e);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// --- Исходящие запросы ---
app.get("/api/friends/requests/outgoing", authMiddleware, async (req, res) => {
  try {
    const rows = await pool.query(
      `SELECT r.to_nick AS nick, u.uid, u.skin, u.bio, r.created_at
       FROM friend_requests r
       LEFT JOIN users u ON u.nick = r.to_nick
       WHERE r.from_nick = $1
       ORDER BY r.created_at DESC`,
      [req.user.nick]
    );
    res.json(
      rows.rows.map((r) => ({
        nick: r.nick,
        uid: r.uid || r.nick,
        skin: r.skin || null,
        bio: r.bio || "",
        createdAt: Number(r.created_at),
      }))
    );
  } catch (e) {
    console.error("GET /api/friends/requests/outgoing error:", e);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// --- Отправить запрос ---
app.post("/api/friends/request", authMiddleware, async (req, res) => {
  try {
    const { nick } = req.body || {};
    if (typeof nick !== "string" || !nick.trim()) {
      return res.status(400).json({ error: "Введите ник" });
    }

    const target = nick.trim().toLowerCase();
    if (target === req.user.nick) {
      return res.status(400).json({ error: "Это вы" });
    }

    const exists = await pool.query(
      "SELECT nick FROM users WHERE nick = $1",
      [target]
    );
    if (exists.rows.length === 0) {
      return res.status(404).json({ error: "Игрок не найден" });
    }

    const alreadyFriends = await pool.query(
      `SELECT 1 FROM friends WHERE user_nick = $1 AND friend_nick = $2`,
      [req.user.nick, target]
    );
    if (alreadyFriends.rows.length > 0) {
      return res.status(409).json({ error: "Уже в друзьях" });
    }

    // Встречный запрос — сразу друзья
    const reciprocal = await pool.query(
      `SELECT 1 FROM friend_requests
       WHERE from_nick = $1 AND to_nick = $2`,
      [target, req.user.nick]
    );
    if (reciprocal.rows.length > 0) {
      const now = Date.now();
      await pool.query(
        `INSERT INTO friends (user_nick, friend_nick, created_at)
         VALUES ($1, $2, $3), ($2, $1, $3)
         ON CONFLICT DO NOTHING`,
        [req.user.nick, target, now]
      );
      await pool.query(
        `DELETE FROM friend_requests
         WHERE (from_nick = $1 AND to_nick = $2)
            OR (from_nick = $2 AND to_nick = $1)`,
        [req.user.nick, target]
      );
      return res.json({ ok: true, accepted: true, nick: target });
    }

    const sent = await pool.query(
      `SELECT 1 FROM friend_requests
       WHERE from_nick = $1 AND to_nick = $2`,
      [req.user.nick, target]
    );
    if (sent.rows.length > 0) {
      return res.status(409).json({ error: "Запрос уже отправлен" });
    }

    await pool.query(
      `INSERT INTO friend_requests (from_nick, to_nick, created_at)
       VALUES ($1, $2, $3)`,
      [req.user.nick, target, Date.now()]
    );

    res.json({ ok: true, nick: target });
  } catch (e) {
    console.error("POST /api/friends/request error:", e);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// --- Принять запрос ---
app.post("/api/friends/accept", authMiddleware, async (req, res) => {
  try {
    const { nick } = req.body || {};
    if (typeof nick !== "string" || !nick.trim()) {
      return res.status(400).json({ error: "Введите ник" });
    }
    const from = nick.trim().toLowerCase();

    const reqRow = await pool.query(
      `SELECT 1 FROM friend_requests
       WHERE from_nick = $1 AND to_nick = $2`,
      [from, req.user.nick]
    );
    if (reqRow.rows.length === 0) {
      return res.status(404).json({ error: "Запрос не найден" });
    }

    const now = Date.now();
    await pool.query(
      `INSERT INTO friends (user_nick, friend_nick, created_at)
       VALUES ($1, $2, $3), ($2, $1, $3)
       ON CONFLICT DO NOTHING`,
      [req.user.nick, from, now]
    );
    await pool.query(
      `DELETE FROM friend_requests
       WHERE (from_nick = $1 AND to_nick = $2)
          OR (from_nick = $2 AND to_nick = $1)`,
      [req.user.nick, from]
    );

    res.json({ ok: true, nick: from });
  } catch (e) {
    console.error("POST /api/friends/accept error:", e);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// --- Отклонить входящий ---
app.post("/api/friends/decline", authMiddleware, async (req, res) => {
  try {
    const { nick } = req.body || {};
    if (typeof nick !== "string" || !nick.trim()) {
      return res.status(400).json({ error: "Введите ник" });
    }
    const from = nick.trim().toLowerCase();

    await pool.query(
      `DELETE FROM friend_requests
       WHERE from_nick = $1 AND to_nick = $2`,
      [from, req.user.nick]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/friends/decline error:", e);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// --- Отменить свой исходящий ---
app.delete("/api/friends/request/:nick", authMiddleware, async (req, res) => {
  try {
    const target = String(req.params.nick || "").toLowerCase();
    if (!target) return res.status(400).json({ error: "Ник обязателен" });

    await pool.query(
      `DELETE FROM friend_requests
       WHERE from_nick = $1 AND to_nick = $2`,
      [req.user.nick, target]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/friends/request error:", e);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// --- Удалить друга ---
app.delete("/api/friends/:nick", authMiddleware, async (req, res) => {
  try {
    const target = String(req.params.nick || "").toLowerCase();
    if (!target) return res.status(400).json({ error: "Ник обязателен" });

    await pool.query(
      `DELETE FROM friends
       WHERE (user_nick = $1 AND friend_nick = $2)
          OR (user_nick = $2 AND friend_nick = $1)`,
      [req.user.nick, target]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/friends error:", e);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// --- Heartbeat ---
app.post("/api/presence/heartbeat", authMiddleware, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO last_seen (nick, last_seen_at)
       VALUES ($1, $2)
       ON CONFLICT (nick) DO UPDATE SET last_seen_at = $2`,
      [req.user.nick, Date.now()]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/presence/heartbeat error:", e);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// ---------- Skin PNG ----------
app.get("/api/skins/:nick", async (req, res) => {
  const user = await getUser(String(req.params.nick));
  if (!user || !user.skin) return res.status(404).send("No skin");
  const m = /^data:image\/png;base64,(.+)$/.exec(user.skin);
  if (!m) return res.status(500).send("Bad skin format");
  const buf = Buffer.from(m[1], "base64");
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "no-cache");
  res.send(buf);
});

// ---------- Launcher flow ----------
app.get("/api/launcher/status", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).json({ error: "code обязателен" });
  const r = await pool.query("SELECT * FROM launcher_codes WHERE code = $1", [
    code,
  ]);
  const entry = r.rows[0];
  if (!entry) return res.json({ status: "pending" });
  if (Date.now() > entry.expires_at) {
    await pool.query("DELETE FROM launcher_codes WHERE code = $1", [code]);
    return res.json({ status: "expired" });
  }
  const user = await getUser(entry.nick);
  await pool.query("DELETE FROM launcher_codes WHERE code = $1", [code]);
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

app.post("/api/launcher/approve", authMiddleware, async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: "code обязателен" });
    await pool.query(
      `INSERT INTO launcher_codes (code, nick, token, expires_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO UPDATE SET nick = $2, token = $3, expires_at = $4`,
      [code, req.user.nick, req.token, Date.now() + 5 * 60 * 1000]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("approve error:", e);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/launcher", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "launcher.html"));
});

// ---------- Yggdrasil ----------
app.get("/api/yggdrasil", (req, res) => {
  res.json({
    meta: {
      serverName: "twilightDLC",
      implementationName: "twilightDLC-skin-server",
      implementationVersion: "1.0.0",
    },
    skinDomains: [new URL(BASE_URL).hostname],
  });
});

app.get(
  "/api/yggdrasil/sessionserver/session/minecraft/profile/:uuid",
  async (req, res) => {
    try {
      const uuid = String(req.params.uuid).replace(/-/g, "").toLowerCase();
      const r = await pool.query("SELECT * FROM users");
      const userEntry = r.rows.find((u) => uuidNoDashes(u.nick) === uuid);
      if (!userEntry) return res.status(204).end();

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
    } catch (e) {
      console.error("yggdrasil profile error:", e);
      res.status(500).json({ error: "Server error" });
    }
  }
);

app.post(
  "/api/yggdrasil/sessionserver/session/minecraft/join",
  (req, res) => res.status(204).end()
);
app.get(
  "/api/yggdrasil/sessionserver/session/minecraft/hasJoined",
  (req, res) => res.json(null)
);
app.post("/api/yggdrasil/authserver/authenticate", (req, res) =>
  res.status(403).json({ error: "ForbiddenOperationException" })
);

// ---------- Start ----------
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`BASE_URL: ${BASE_URL}`);
      console.log(`Brevo sender: ${BREVO_SENDER_EMAIL}`);
    });
  })
  .catch((e) => {
    console.error("DB init failed:", e);
    process.exit(1);
  });