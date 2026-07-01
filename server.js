require('dotenv').config();

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const db = require('./src/db');
const tg = require('./src/telegram');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// -------------------- Аккаунты --------------------

app.get('/api/accounts', (req, res) => {
  const accounts = db
    .get('accounts')
    .value()
    .map((a) => ({ id: a.id, label: a.label, firstName: a.firstName, createdAt: a.createdAt }));
  res.json({ accounts });
});

app.delete('/api/accounts/:id', (req, res) => {
  db.get('accounts').remove({ id: req.params.id }).write();
  res.json({ ok: true });
});

function saveAccount({ sessionString, label, firstName }) {
  const existing = db.get('accounts').find({ label }).value();
  if (existing) {
    db.get('accounts')
      .find({ label })
      .assign({ sessionString, firstName, updatedAt: Date.now() })
      .write();
    return existing.id;
  }
  const id = uuidv4();
  db.get('accounts')
    .push({ id, sessionString, label, firstName, createdAt: Date.now() })
    .write();
  return id;
}

// -------------------- Вход по строке сессии --------------------

app.post('/api/login/string', async (req, res) => {
  try {
    const { sessionString, customLabel } = req.body;
    if (!sessionString || !sessionString.trim()) {
      return res.status(400).json({ error: 'Строка сессии пустая' });
    }
    const result = await tg.loginWithStringSession(sessionString.trim());
    const label = customLabel && customLabel.trim() ? customLabel.trim() : result.label;
    const id = saveAccount({ ...result, label });
    res.json({ ok: true, id, label });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Не удалось войти по строке сессии' });
  }
});

// -------------------- Вход по номеру телефона --------------------

app.post('/api/login/phone/start', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || !phone.trim()) {
      return res.status(400).json({ error: 'Укажи номер телефона' });
    }
    const loginId = await tg.startPhoneLogin(phone.trim());
    res.json({ ok: true, loginId });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Не удалось отправить код' });
  }
});

app.post('/api/login/phone/code', async (req, res) => {
  try {
    const { loginId, code } = req.body;
    if (!loginId || !code) {
      return res.status(400).json({ error: 'Не хватает данных' });
    }
    const result = await tg.submitPhoneCode(loginId, code.trim());
    if (result.needPassword) {
      return res.json({ ok: true, needPassword: true });
    }
    const id = saveAccount(result);
    res.json({ ok: true, id, label: result.label });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Неверный код' });
  }
});

app.post('/api/login/phone/password', async (req, res) => {
  try {
    const { loginId, password } = req.body;
    if (!loginId || !password) {
      return res.status(400).json({ error: 'Не хватает данных' });
    }
    const result = await tg.submitPhonePassword(loginId, password);
    const id = saveAccount(result);
    res.json({ ok: true, id, label: result.label });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Неверный пароль' });
  }
});

// -------------------- Джоба проверки промокодов --------------------

const activeJobs = new Map(); // jobId -> { stop: boolean }

app.post('/api/job/start', async (req, res) => {
  try {
    const { accountId, messages } = req.body;
    if (!accountId) return res.status(400).json({ error: 'Не выбран аккаунт' });
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Список промокодов пуст' });
    }

    const account = db.get('accounts').find({ id: accountId }).value();
    if (!account) return res.status(404).json({ error: 'Аккаунт не найден' });

    const jobId = uuidv4();
    const jobState = { stop: false };
    activeJobs.set(jobId, jobState);

    res.json({ ok: true, jobId });

    // Запускаем в фоне, прогресс шлём через сокет в комнату job-<jobId>
    tg.runCheckJob({
      sessionString: account.sessionString,
      messages,
      shouldStop: () => jobState.stop,
      onEvent: (evt) => {
        io.to(`job-${jobId}`).emit('job-event', evt);
        if (evt.type === 'done' || evt.type === 'error' || evt.type === 'stopped') {
          activeJobs.delete(jobId);
        }
      },
    }).catch((err) => {
      io.to(`job-${jobId}`).emit('job-event', { type: 'error', message: err.message || String(err) });
      activeJobs.delete(jobId);
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Не удалось запустить проверку' });
  }
});

app.post('/api/job/stop', (req, res) => {
  const { jobId } = req.body;
  const jobState = activeJobs.get(jobId);
  if (jobState) jobState.stop = true;
  res.json({ ok: true });
});

// -------------------- Socket.io --------------------

io.on('connection', (socket) => {
  socket.on('join-job', (jobId) => {
    socket.join(`job-${jobId}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
