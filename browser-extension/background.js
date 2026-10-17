let timer;
let pending = Promise.resolve();
let polling = false;
const sessionId = crypto.randomUUID();
const reconnectAlarm = 'tabtidy-reconnect';

async function request(path, data, connectionCode, timeout = 5000) {
  const response = await fetch(`http://127.0.0.1:37843${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connectionCode}` },
    body: JSON.stringify(data), signal: AbortSignal.timeout(timeout),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '桌面端拒绝了本次请求，请更新桌面端与扩展后重新同步。');
  return result;
}

async function reportError(error) {
  const message = error.message === 'Failed to fetch' ? '桌面端暂未连接，扩展会自动重连。请确认 TabTidy 已打开。' : error.message;
  await chrome.storage.local.set({ lastError: message });
  await chrome.action.setBadgeText({ text: '!' });
  await chrome.action.setBadgeBackgroundColor({ color: '#a45b3f' });
  return message;
}

async function closeTabs(command) {
  if (command.type !== 'close-tabs' || command.sessionId !== sessionId || typeof command.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(command.requestId)
    || !Number.isFinite(command.expiresAt) || command.expiresAt > Date.now() + 35000
    || !Array.isArray(command.tabs) || !command.tabs.length || command.tabs.length > 5000
    || command.tabs.some((tab) => !tab || !Number.isSafeInteger(tab.id) || tab.id < 0
      || typeof tab.title !== 'string' || tab.title.length > 2048 || typeof tab.url !== 'string' || tab.url.length > 8192)
    || new Set(command.tabs.map((tab) => tab.id)).size !== command.tabs.length) throw new Error('关闭指令无效，未执行关闭。');
  const results = [];
  for (const target of command.tabs) {
    let tab;
    try { tab = await chrome.tabs.get(target.id); }
    catch { results.push({ id: target.id, status: 'skipped', error: '标签页已关闭或无法读取。' }); continue; }
    try {
      if (Date.now() >= command.expiresAt || tab.incognito || !target.url || tab.url !== target.url
        || tab.pendingUrl || (tab.title || '') !== target.title) {
        results.push({ id: target.id, status: 'skipped', error: '页面已变化、正在跳转或请求已过期。' });
        continue;
      }
      // shortcut: 核对与关闭无法原子执行，浏览器提供条件关闭接口时再替换。
      await chrome.tabs.remove(target.id);
      let stillOpen = false;
      try { await chrome.tabs.get(target.id); stillOpen = true; } catch { /* 已不存在。 */ }
      results.push(stillOpen ? { id: target.id, status: 'failed', error: '浏览器仍保留该标签页，请检查关闭提示。' } : { id: target.id, status: 'closed' });
    } catch (error) {
      results.push({ id: target.id, status: 'failed', error: String(error.message || '标签页已不存在或浏览器拒绝关闭。').slice(0, 512) });
    }
  }
  return results;
}

async function pollCommands() {
  if (polling) return;
  polling = true;
  try {
    while (true) {
      const settings = await chrome.storage.local.get(['connectionCode', 'sourceId']);
      if (!settings.connectionCode || !settings.sourceId) break;
      // 每轮最长等待 20 秒，再调用扩展 API，避免超过 MV3 的 30 秒空闲限制。
      const { command } = await request('/commands', { sourceId: settings.sourceId, sessionId }, settings.connectionCode, 25000);
      if (!command) continue;
      const results = await closeTabs(command);
      clearTimeout(timer);
      try { await queueSync(); } catch { /* 仍回报已经执行的结果，不重试关闭。 */ }
      await request('/results', { sourceId: settings.sourceId, sessionId, requestId: command.requestId, results }, settings.connectionCode);
    }
  } catch (error) { await reportError(error); }
  finally { polling = false; }
}

async function syncTabs() {
  const settings = await chrome.storage.local.get(['connectionCode', 'sourceId']);
  if (!settings.connectionCode) return { ok: false, error: '请先粘贴桌面端的连接码。' };
  if (!await chrome.alarms.get(reconnectAlarm)) await chrome.alarms.create(reconnectAlarm, { periodInMinutes: 0.5 });
  const sourceId = settings.sourceId || crypto.randomUUID();
  if (!settings.sourceId) await chrome.storage.local.set({ sourceId });
  const browser = /Edg\//.test(navigator.userAgent) ? 'Edge' : 'Chrome';
  const tabs = (await chrome.tabs.query({})).filter((tab) => !tab.incognito && Number.isSafeInteger(tab.id))
    .map((tab) => ({ id: tab.id, title: tab.title || '', url: tab.url || tab.pendingUrl || '' }));
  const result = await request('/tabs', { sourceId, sessionId, browser, tabs }, settings.connectionCode);
  await chrome.storage.local.set({ lastCount: result.count, lastSync: Date.now(), lastError: '' });
  await chrome.action.setBadgeText({ text: '' });
  void pollCommands();
  return result;
}

function queueSync() {
  pending = pending.catch(() => {}).then(syncTabs).catch(async (error) => {
    throw new Error(await reportError(error));
  });
  return pending;
}

function scheduleSync() {
  clearTimeout(timer);
  timer = setTimeout(() => { void queueSync().catch(() => {}); }, 350);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.type !== 'sync') return;
  queueSync().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
chrome.tabs.onCreated.addListener(scheduleSync);
chrome.tabs.onRemoved.addListener(scheduleSync);
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.title !== undefined || change.url !== undefined) scheduleSync();
});
chrome.runtime.onStartup.addListener(scheduleSync);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === reconnectAlarm && !polling) void queueSync().catch(() => {});
});
void queueSync().catch(() => {});
