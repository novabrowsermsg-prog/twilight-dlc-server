const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const MODS_DIR = path.join(__dirname, "mods");

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

// Профиль сборки
app.get("/minecraft/api/v1/profile", (req, res) => {
  const profilePath = path.join(__dirname, "profile.json");
  fs.readFile(profilePath, "utf8", (err, data) => {
    if (err) return res.status(404).json({ error: "Profile not found" });
    res.json(JSON.parse(data));
  });
});

// Хеш файла
function sha1File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha1");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

// Рекурсивно находим все файлы в mods/
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
      const sha1 = await sha1File(full);
      result[key] = { sha1, size: stat.size };
    }
  }
  return result;
}

// Манифест модов
app.get("/minecraft/api/v1/manifest", async (req, res) => {
  try {
    if (!fs.existsSync(MODS_DIR)) {
      return res.json({ files: {} });
    }
    const files = await walkMods(MODS_DIR);
    res.json({ files });
  } catch (error) {
    console.error("Manifest error:", error);
    res.status(500).json({ error: "Manifest failed" });
  }
});

// Раздача файлов модов
app.get("/minecraft/api/v1/files/mods/:name", (req, res) => {
  const name = req.params.name;
  // Защита от path traversal
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    return res.status(400).json({ error: "Invalid file" });
  }
  const filePath = path.join(MODS_DIR, name);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }
  res.sendFile(filePath);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Mods dir: ${MODS_DIR}`);
});