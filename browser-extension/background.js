let timer;
let pending = Promise.resolve();

async function syncTabs() {
  const settings = await chrome.storage.local.get(['connectionCode', 'sourceId']);
  if (!settings.connectionCode) return { ok: false, error: '请先粘贴桌面端的连接码。' };
  const sourceId = settings.sourceId || crypto.randomUUID();
  if (!settings.sourceId) await chrome.storage.local.set({ sourceId });
  const browser = /Edg\//.test(navigator.userAgent) ? 'Edge' : 'Chrome';
  const tabs = (await chrome.tabs.query({})).filter((tab) => !tab.incognito && Number.isSafeInteger(tab.id))
    .map((tab) => ({ id: tab.id, title: tab.title || '', url: tab.url || tab.pendingUrl || '' }));
  const response = await fetch('http://127.0.0.1:37843/tabs', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.connectionCode}` },
    body: JSON.stringify({ sourceId, browser, tabs }), signal: AbortSignal.timeout(5000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '桌面端拒绝了本次同步。');
  await chrome.storage.local.set({ lastCount: result.count, lastSync: Date.now(), lastError: '' });
  await chrome.action.setBadgeText({ text: '' });
  return result;
}

function queueSync() {
  pending = pending.catch(() => {}).then(syncTabs).catch(async (error) => {
    const message = error.message === 'Failed to fetch' ? '无法连接桌面端，请先打开 TabTidy。' : error.message;
    await chrome.storage.local.set({ lastError: message });
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#a45b3f' });
    throw new Error(message);
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
