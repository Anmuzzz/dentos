const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════════
// НАСТРОЙКИ (через переменные окружения или .env)
// ═══════════════════════════════════════════════════
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';     // токен бота от @BotFather
const TG_CHAT_ID  = process.env.TG_CHAT_ID  || '';       // ID чата админа
const ADMIN_USER  = process.env.ADMIN_USER  || 'admin';   // логин для /admin
const ADMIN_PASS  = process.env.ADMIN_PASS  || 'dentos';  // пароль для /admin

// ===================== Telegram =====================
async function sendTelegram(msg) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text: msg,
        parse_mode: 'HTML',
      }),
    });
  } catch (err) {
    console.error('Telegram notify error:', err.message);
  }
}

// ===================== Basic Auth =====================
function basicAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="DentOs Admin"');
    return res.status(401).send('Требуется авторизация');
  }
  const b64 = header.slice(6);
  const [user, pass] = Buffer.from(b64, 'base64').toString().split(':');
  if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="DentOs Admin"');
  res.status(401).send('Неверный логин или пароль');
}

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ===================== DB init =====================
const db = new Database(path.join(__dirname, 'dentos.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    service TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    comment TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now', '+3 hours'))
  )
`);

const stmtInsert = db.prepare(
  'INSERT INTO appointments (name, phone, service, date, time, comment) VALUES (@name, @phone, @service, @date, @time, @comment)'
);
const stmtCheckConflict = db.prepare(
  'SELECT id FROM appointments WHERE date = @date AND time = @time'
);
const stmtListByDate = db.prepare(
  'SELECT * FROM appointments WHERE date = @date ORDER BY time ASC'
);
const stmtGetById = db.prepare('SELECT * FROM appointments WHERE id = ?');
const stmtDelete = db.prepare('DELETE FROM appointments WHERE id = ?');
const stmtListAll = db.prepare(
  'SELECT * FROM appointments ORDER BY date DESC, time ASC'
);

// ===================== API =====================

// список записей на дату
app.get('/api/appointments', (req, res) => {
  const { date } = req.query;
  if (date) {
    const rows = stmtListByDate.all({ date });
    res.json(rows);
  } else {
    const rows = stmtListAll.all();
    res.json(rows);
  }
});

// свободные слоты на дату
app.get('/api/slots', (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });

  const taken = stmtListByDate.all({ date }).map(a => a.time);
  const allSlots = [];
  for (let h = 10; h <= 20; h++) {
    for (let m = 0; m < 60; m += 60) {
      const t = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      if (!taken.includes(t)) allSlots.push(t);
    }
  }
  res.json(allSlots);
});

// создать запись
app.post('/api/appointments', (req, res) => {
  const { name, phone, date, time } = req.body;
  const service = req.body.service || '';
  const comment = req.body.comment || '';

  if (!name || !phone || !date || !time) {
    return res.status(400).json({ error: 'name, phone, date, time обязательны' });
  }

  // проверка рабочих часов (10:00–21:00)
  const hour = parseInt(time.split(':')[0], 10);
  if (hour < 10 || hour >= 21) {
    return res.status(400).json({ error: 'Приём только с 10:00 до 21:00' });
  }

  // проверка на сегодня — время не в прошлом
  const tzOffset = 3; // MSK
  const now = new Date();
  const localNow = new Date(now.getTime() + tzOffset * 3600000);
  const today = localNow.toISOString().split('T')[0];
  if (date === today) {
    const [h, m] = time.split(':').map(Number);
    const currentMin = localNow.getHours() * 60 + localNow.getMinutes();
    const slotMin = h * 60 + m;
    if (slotMin <= currentMin) {
      return res.status(400).json({ error: 'Нельзя записаться на прошедшее время' });
    }
  }

  // проверка конфликта
  const conflict = stmtCheckConflict.get({ date, time });
  if (conflict) {
    return res.status(409).json({ error: 'Это время уже занято. Выберите другое.' });
  }

  try {
    const info = stmtInsert.run({ name, phone, service, date, time, comment });

    // уведомление в Telegram
    const serviceText = service ? `• Услуга: ${service}\n` : '';
    sendTelegram(
      `<b>Новая запись! 🦷</b>\n` +
      `• Имя: ${name}\n` +
      `• Телефон: ${phone}\n` +
      `• Дата: ${date}\n` +
      `• Время: ${time}\n` +
      serviceText +
      (comment ? `• Комментарий: ${comment}` : '')
    );

    res.status(201).json({ id: info.lastInsertRowid, message: 'Запись создана' });
  } catch (err) {
    console.error('Appointment insert error:', err.message);
    res.status(500).json({ error: 'Ошибка сервера: ' + err.message });
  }
});

// удалить запись (админ)
app.delete('/api/appointments/:id', (req, res) => {
  const existing = stmtGetById.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Запись не найдена' });

  stmtDelete.run(req.params.id);
  res.json({ message: 'Запись удалена' });
});

// ===================== Admin panel =====================
app.get('/admin', basicAuth, (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Админ — ДентОс</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Outfit', sans-serif; background: #f8fafc; color: #0f172a; padding: 32px; }
  .container { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 28px; font-weight: 700; margin-bottom: 8px; }
  p { color: #64748b; margin-bottom: 24px; }
  .filters { display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
  .filters input, .filters button {
    padding: 10px 16px; border: 1.5px solid #e2e8f0; border-radius: 8px;
    font-family: 'Outfit', sans-serif; font-size: 14px;
  }
  .filters button {
    background: #2563eb; color: #fff; border: none; cursor: pointer; font-weight: 600;
  }
  .filters button:hover { background: #1d4ed8; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  th, td { padding: 12px 16px; text-align: left; font-size: 14px; border-bottom: 1px solid #e2e8f0; }
  th { background: #f1f5f9; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #475569; }
  .delete-btn {
    padding: 6px 12px; border: none; border-radius: 6px; font-size: 12px; cursor: pointer;
    font-family: 'Outfit', sans-serif; font-weight: 600;
    background: #fef2f2; color: #dc2626;
  }
  .delete-btn:hover { background: #fee2e2; }
  .empty { text-align: center; padding: 48px; color: #94a3b8; }
  .toast { position: fixed; bottom: 24px; right: 24px; padding: 12px 20px; border-radius: 8px; color: #fff; font-size: 14px; display: none; }
  .toast.success { background: #16a34a; }
  .toast.error { background: #dc2626; }
</style>
</head>
<body>
<div class="container">
  <h1>Панель управления</h1>
  <p>Все записи на приём</p>
  <div class="filters">
    <input type="date" id="filterDate" />
    <button onclick="applyFilter()">Фильтр по дате</button>
    <button onclick="clearFilter()">Все записи</button>
  </div>
  <table>
    <thead>
      <tr>
        <th>ID</th>
        <th>Дата</th>
        <th>Время</th>
        <th>Имя</th>
        <th>Телефон</th>
        <th>Услуга</th>
        <th>Комментарий</th>
        <th></th>
      </tr>
    </thead>
    <tbody id="tbody"></tbody>
  </table>
</div>
<div id="toast" class="toast"></div>
<script>
  async function load(date) {
    const url = date ? '/api/appointments?date=' + date : '/api/appointments';
    const res = await fetch(url);
    const data = await res.json();
    const tbody = document.getElementById('tbody');
    if (data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">Записей нет</td></tr>';
      return;
    }
    tbody.innerHTML = data.map(a => '<tr>' +
      '<td>' + a.id + '</td>' +
      '<td>' + a.date + '</td>' +
      '<td><strong>' + a.time + '</strong></td>' +
      '<td>' + escapeHtml(a.name) + '</td>' +
      '<td>' + escapeHtml(a.phone) + '</td>' +
      '<td>' + escapeHtml(a.service || '—') + '</td>' +
      '<td>' + escapeHtml(a.comment || '—') + '</td>' +
      '<td><button class="delete-btn" onclick="del(' + a.id + ')">Удалить</button></td>' +
      '</tr>').join('');
  }
  function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  async function del(id) {
    if (!confirm('Удалить запись №' + id + '?')) return;
    const res = await fetch('/api/appointments/' + id, { method: 'DELETE' });
    const data = await res.json();
    showToast(data.error || data.message, res.ok ? 'success' : 'error');
    load(document.getElementById('filterDate').value);
  }
  function applyFilter() { load(document.getElementById('filterDate').value); }
  function clearFilter() { document.getElementById('filterDate').value = ''; load(); }
  function showToast(msg, type) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'toast ' + type; t.style.display = 'block';
    setTimeout(() => t.style.display = 'none', 3000);
  }
  // set default filter to today
  document.getElementById('filterDate').value = new Date().toISOString().split('T')[0];
  load(document.getElementById('filterDate').value);
</script>
</body>
</html>
  `);
});

// ===================== Start =====================
app.listen(PORT, () => {
  console.log(`ДентОс backend: http://localhost:${PORT}`);
  console.log(`Admin panel:    http://localhost:${PORT}/admin`);
});
