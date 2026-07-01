const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { computeCheck } = require('telegram/Password');
const { v4: uuidv4 } = require('uuid');

const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
const apiHash = process.env.TELEGRAM_API_HASH;
const BOT_USERNAME = process.env.TARGET_BOT_USERNAME || 'LuckChecker_robot';

// Если в ответе LuckChecker_robot при совпадении встречается эта фраза —
// пересылаем не в избранное, а в личку указанному юзернейму.
const SPECIAL_KEYWORD = process.env.SPECIAL_KEYWORD || 'Источник: SpookyTime';
const SPECIAL_FORWARD_USERNAME = process.env.SPECIAL_FORWARD_USERNAME || 'xikik0mori';

if (!apiId || !apiHash) {
  console.warn(
    '[ВНИМАНИЕ] TELEGRAM_API_ID / TELEGRAM_API_HASH не заданы в переменных окружения.'
  );
}

// Незавершённые входы по номеру телефона: loginId -> { client, phone, phoneCodeHash }
const pendingLogins = new Map();

function makeLabel(me) {
  if (me.phone) return `+${me.phone}`;
  if (me.username) return `@${me.username}`;
  return me.firstName || 'Аккаунт';
}

async function createClient(sessionString = '') {
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 10,
    retryDelay: 2000,
    autoReconnect: true,
    requestRetries: 5,
  });
  await client.connect();
  return client;
}

// ---------- Вход по строке сессии ----------
async function loginWithStringSession(sessionString) {
  const client = await createClient(sessionString);
  try {
    const me = await client.getMe();
    const finalSession = client.session.save();
    return {
      sessionString: finalSession,
      label: makeLabel(me),
      firstName: me.firstName || '',
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

// ---------- Вход по номеру: шаг 1 - отправка кода ----------
async function startPhoneLogin(phone) {
  const client = await createClient('');
  const result = await client.sendCode({ apiId, apiHash }, phone);
  const loginId = uuidv4();
  pendingLogins.set(loginId, {
    client,
    phone,
    phoneCodeHash: result.phoneCodeHash,
    createdAt: Date.now(),
  });
  return loginId;
}

// ---------- Вход по номеру: шаг 2 - код из смс/телеграма ----------
async function submitPhoneCode(loginId, code) {
  const entry = pendingLogins.get(loginId);
  if (!entry) throw new Error('Сессия входа не найдена или истекла, начни заново');
  const { client, phone, phoneCodeHash } = entry;

  try {
    await client.invoke(
      new Api.auth.SignIn({
        phoneNumber: phone,
        phoneCodeHash,
        phoneCode: code,
      })
    );
  } catch (err) {
    if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
      return { needPassword: true };
    }
    pendingLogins.delete(loginId);
    await client.disconnect().catch(() => {});
    throw err;
  }

  const me = await client.getMe();
  const sessionString = client.session.save();
  pendingLogins.delete(loginId);
  await client.disconnect().catch(() => {});

  return {
    needPassword: false,
    sessionString,
    label: makeLabel(me),
    firstName: me.firstName || '',
  };
}

// ---------- Вход по номеру: шаг 3 - пароль 2FA (если включён) ----------
async function submitPhonePassword(loginId, password) {
  const entry = pendingLogins.get(loginId);
  if (!entry) throw new Error('Сессия входа не найдена или истекла, начни заново');
  const { client } = entry;

  try {
    const passwordInfo = await client.invoke(new Api.account.GetPassword());
    const check = await computeCheck(passwordInfo, password);
    await client.invoke(new Api.auth.CheckPassword({ password: check }));

    const me = await client.getMe();
    const sessionString = client.session.save();
    return {
      sessionString,
      label: makeLabel(me),
      firstName: me.firstName || '',
    };
  } finally {
    pendingLogins.delete(loginId);
    await client.disconnect().catch(() => {});
  }
}

// ---------- Ожидание ответа бота (только входящие сообщения, прерываемое) ----------
function waitForReply(client, botEntity, timeoutMs, shouldStop) {
  return new Promise((resolve) => {
    let settled = false;
    // ВАЖНО: в chats передаём именно botEntity.id (число/bigint), а не сам
    // объект сущности — иначе gramjs пытается сериализовать объект в строку
    // при резолве апдейта и падает с "Cannot find any entity corresponding
    // to [object Object]", роняя весь процесс.
    // incoming: true — чтобы не ловить наше же отправленное сообщение.
    const eventBuilder = new NewMessage({ chats: [botEntity.id], incoming: true });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      client.removeEventHandler(handler, eventBuilder);
      clearTimeout(timeoutHandle);
      clearInterval(stopInterval);
      resolve(result);
    };

    const handler = (event) => finish({ message: event.message });

    client.addEventHandler(handler, eventBuilder);

    const timeoutHandle = setTimeout(() => finish(null), timeoutMs);

    // каждые 300мс проверяем, не нажали ли "Остановить"
    const stopInterval = setInterval(() => {
      if (shouldStop()) finish('STOPPED');
    }, 300);
  });
}

// ---------- Пауза, которую можно прервать кнопкой "Остановить" ----------
function interruptibleSleep(ms, shouldStop) {
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (shouldStop() || Date.now() - start >= ms) {
        clearInterval(interval);
        resolve();
      }
    }, 200);
  });
}

function randomDelay(minMs, maxMs) {
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

// ---------- Запуск проверки списка промокодов ----------
async function runCheckJob({ sessionString, messages, onEvent, shouldStop }) {
  const client = await createClient(sessionString);
  try {
    const bot = await client.getEntity(BOT_USERNAME);

    for (let i = 0; i < messages.length; i++) {
      if (shouldStop()) {
        onEvent({ type: 'stopped', index: i, total: messages.length });
        break;
      }

      const text = (messages[i] || '').trim();
      if (!text) continue;

      await client.sendMessage(bot, { message: text });
      onEvent({ type: 'sent', index: i, total: messages.length, text });

      const result = await waitForReply(client, bot, 15000, shouldStop);

      if (result === 'STOPPED') {
        onEvent({ type: 'stopped', index: i, total: messages.length });
        break;
      }

      if (result) {
        const reply = result.message;
        const replyText = reply.message || '';
        const isMatch = replyText.includes('Найдено совпадение');
        onEvent({ type: 'reply', index: i, total: messages.length, text: replyText, match: isMatch });

        if (isMatch) {
          const isSpecial = replyText.toLowerCase().includes(SPECIAL_KEYWORD.toLowerCase());
          if (isSpecial) {
            const specialUser = await client.getEntity(SPECIAL_FORWARD_USERNAME);
            await client.forwardMessages(specialUser, { messages: [reply.id], fromPeer: bot });
            onEvent({ type: 'forwarded', index: i, total: messages.length, target: SPECIAL_FORWARD_USERNAME });
          } else {
            await client.forwardMessages('me', { messages: [reply.id], fromPeer: bot });
            onEvent({ type: 'forwarded', index: i, total: messages.length, target: 'избранное' });
          }
        }
      } else {
        onEvent({ type: 'timeout', index: i, total: messages.length });
      }

      if (i < messages.length - 1) {
        await interruptibleSleep(randomDelay(3000, 5000), shouldStop);
        if (shouldStop()) {
          onEvent({ type: 'stopped', index: i, total: messages.length });
          break;
        }
      }
    }

    onEvent({ type: 'done' });
  } catch (err) {
    onEvent({ type: 'error', message: err.message || String(err) });
  } finally {
    await client.disconnect().catch(() => {});
  }
}

module.exports = {
  loginWithStringSession,
  startPhoneLogin,
  submitPhoneCode,
  submitPhonePassword,
  runCheckJob,
};
