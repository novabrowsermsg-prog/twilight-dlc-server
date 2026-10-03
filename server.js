const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Разрешаем CORS, чтобы лаунчер мог делать запросы
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Эндпоинт для получения профиля сборки
app.get('/minecraft/api/v1/profile', (req, res) => {
  // Читаем profile.json из той же папки
  const profilePath = path.join(__dirname, 'profile.json');
  fs.readFile(profilePath, 'utf8', (err, data) => {
    if (err) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    res.json(JSON.parse(data));
  });
});

// (Опционально) Эндпоинт для раздачи файлов модов
// Если вы положите .jar файл в папку server_app/mods/, он будет доступен по ссылке
app.use('/mods', express.static(path.join(__dirname, 'mods')));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});