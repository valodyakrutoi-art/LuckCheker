const state = {
  accountId: null,
  accountLabel: null,
  loginId: null,
  jobId: null,
  socket: null,
};

// ---------- Утилиты ----------
function $(id) { return document.getElementById(id); }

function showError(msg) {
  $('loginError').textContent = msg || '';
}

function showScreen(name) {
  $('screen-login').hidden = name !== 'login';
  $('screen-dashboard').hidden = name !== 'dashboard';
}

async function api(url, method = 'GET', body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Ошибка запроса');
  return data;
}

// ---------- Табы входа ----------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $(`tab-${btn.dataset.tab}`).classList.add('active');
    showError('');
  });
});

// ---------- Загрузка списка сохранённых аккаунтов ----------
async function loadAccounts() {
  const { accounts } = await api('/api/accounts');
  const list = $('accountsList');
  list.innerHTML = '';
  if (accounts.length === 0) {
    list.innerHTML = '<div class="empty-hint">Пока нет сохранённых аккаунтов</div>';
    return;
  }
  accounts.forEach((acc) => {
    const item = document.createElement('div');
    item.className = 'account-item';
    item.innerHTML = `<span>${acc.label}</span><button class="del-btn">удалить</button>`;
    item.querySelector('span').addEventListener('click', () => selectAccount(acc.id, acc.label));
    item.querySelector('.del-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      await api(`/api/accounts/${acc.id}`, 'DELETE');
      loadAccounts();
    });
    list.appendChild(item);
  });
}

function selectAccount(id, label) {
  state.accountId = id;
  state.accountLabel = label;
  $('topbarAccount').hidden = false;
  $('topbarAccountLabel').textContent = label;
  showScreen('dashboard');
}

$('switchAccountBtn').addEventListener('click', () => {
  state.accountId = null;
  $('topbarAccount').hidden = true;
  resetLoginForm();
  showScreen('login');
  loadAccounts();
});

// ---------- Вход по стринг-сессии ----------
$('loginStringBtn').addEventListener('click', async () => {
  showError('');
  const sessionString = $('stringSessionInput').value.trim();
  const customLabel = $('stringLabelInput').value.trim();
  if (!sessionString) return showError('Вставь строку сессии');
  $('loginStringBtn').disabled = true;
  try {
    const res = await api('/api/login/string', 'POST', { sessionString, customLabel });
    selectAccount(res.id, res.label);
  } catch (err) {
    showError(err.message);
  } finally {
    $('loginStringBtn').disabled = false;
  }
});

// ---------- Вход по номеру ----------
$('phoneSendCodeBtn').addEventListener('click', async () => {
  showError('');
  const phone = $('phoneInput').value.trim();
  if (!phone) return showError('Укажи номер телефона');
  $('phoneSendCodeBtn').disabled = true;
  try {
    const res = await api('/api/login/phone/start', 'POST', { phone });
    state.loginId = res.loginId;
    $('phoneStep1').hidden = true;
    $('phoneStep2').hidden = false;
  } catch (err) {
    showError(err.message);
  } finally {
    $('phoneSendCodeBtn').disabled = false;
  }
});

$('phoneSubmitCodeBtn').addEventListener('click', async () => {
  showError('');
  const code = $('phoneCodeInput').value.trim();
  if (!code) return showError('Введи код');
  $('phoneSubmitCodeBtn').disabled = true;
  try {
    const res = await api('/api/login/phone/code', 'POST', { loginId: state.loginId, code });
    if (res.needPassword) {
      $('phoneStep2').hidden = true;
      $('phoneStep3').hidden = false;
    } else {
      selectAccount(res.id, res.label);
    }
  } catch (err) {
    showError(err.message);
  } finally {
    $('phoneSubmitCodeBtn').disabled = false;
  }
});

$('phoneSubmitPasswordBtn').addEventListener('click', async () => {
  showError('');
  const password = $('phonePasswordInput').value;
  if (!password) return showError('Введи пароль');
  $('phoneSubmitPasswordBtn').disabled = true;
  try {
    const res = await api('/api/login/phone/password', 'POST', { loginId: state.loginId, password });
    selectAccount(res.id, res.label);
  } catch (err) {
    showError(err.message);
  } finally {
    $('phoneSubmitPasswordBtn').disabled = false;
  }
});

function resetLoginForm() {
  $('phoneStep1').hidden = false;
  $('phoneStep2').hidden = true;
  $('phoneStep3').hidden = true;
  $('phoneInput').value = '';
  $('phoneCodeInput').value = '';
  $('phonePasswordInput').value = '';
  $('stringSessionInput').value = '';
  $('stringLabelInput').value = '';
  showError('');
}

// ---------- Загрузка .txt файла ----------
$('uploadFileBtn').addEventListener('click', () => $('fileInput').click());

$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  $('messagesInput').value = text.trim();
  $('fileNameLabel').textContent = file.name;
});

// ---------- Джоба проверки ----------
function appendLog(html, cls) {
  const line = document.createElement('div');
  line.className = `log-line ${cls || ''}`;
  line.innerHTML = html;
  $('logArea').appendChild(line);
  $('logArea').scrollTop = $('logArea').scrollHeight;
}

function ensureSocket() {
  if (state.socket) return state.socket;
  state.socket = io();
  state.socket.on('job-event', handleJobEvent);
  return state.socket;
}

function handleJobEvent(evt) {
  switch (evt.type) {
    case 'sent':
      $('progressLine').textContent = `Проверка ${evt.index + 1} из ${evt.total}...`;
      appendLog(`→ отправлено: <b>${escapeHtml(evt.text)}</b>`, 'neutral');
      break;
    case 'reply':
      if (evt.match) {
        appendLog(`✅ СОВПАДЕНИЕ: ${escapeHtml(evt.text)}`, 'match');
      } else {
        appendLog(`❌ нет совпадения`, 'neutral');
      }
      break;
    case 'forwarded':
      appendLog(`📌 переслано в ${evt.target || 'избранное'}`, 'match');
      break;
    case 'timeout':
      appendLog(`⚠️ бот не ответил вовремя, пропускаю`, 'error');
      break;
    case 'stopped':
      $('progressLine').textContent = 'Остановлено пользователем';
      finishJob();
      break;
    case 'error':
      appendLog(`Ошибка: ${escapeHtml(evt.message)}`, 'error');
      $('progressLine').textContent = 'Проверка прервана из-за ошибки';
      finishJob();
      break;
    case 'done':
      $('progressLine').textContent = 'Проверка завершена';
      finishJob();
      break;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function finishJob() {
  state.jobId = null;
  $('startJobBtn').hidden = false;
  $('stopJobBtn').hidden = true;
}

$('startJobBtn').addEventListener('click', async () => {
  const raw = $('messagesInput').value;
  const messages = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  if (messages.length === 0) {
    alert('Впиши хотя бы один промокод или загрузи файл');
    return;
  }
  $('logArea').innerHTML = '';
  $('progressLine').textContent = 'Запуск...';
  $('startJobBtn').hidden = true;
  $('stopJobBtn').hidden = false;

  try {
    const res = await api('/api/job/start', 'POST', { accountId: state.accountId, messages });
    state.jobId = res.jobId;
    const socket = ensureSocket();
    socket.emit('join-job', state.jobId);
  } catch (err) {
    appendLog(`Ошибка запуска: ${escapeHtml(err.message)}`, 'error');
    finishJob();
  }
});

$('stopJobBtn').addEventListener('click', async () => {
  if (!state.jobId) return;
  await api('/api/job/stop', 'POST', { jobId: state.jobId });
});

// ---------- Инициализация ----------
loadAccounts();
