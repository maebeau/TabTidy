const code = document.getElementById('code');
const status = document.getElementById('status');
const button = document.getElementById('sync');

chrome.storage.local.get(['connectionCode', 'lastCount', 'lastSync', 'lastError']).then((settings) => {
  code.value = settings.connectionCode || '';
  button.textContent = settings.connectionCode ? '立即同步' : '配对并同步标签页';
  status.textContent = settings.lastError || (settings.lastSync ? `上次同步 ${settings.lastCount} 个标签页 · ${new Date(settings.lastSync).toLocaleTimeString()}` : '先打开 TabTidy 桌面端。');
  status.classList.toggle('error', Boolean(settings.lastError));
});
document.getElementById('connect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const connectionCode = code.value.trim().toLowerCase();
  status.classList.remove('error');
  if (!/^[a-f0-9]{32}$/.test(connectionCode)) {
    status.textContent = '连接码应为 32 位，请从桌面应用重新复制。';
    status.classList.add('error');
    return;
  }
  button.disabled = true;
  status.textContent = '正在同步标签页…';
  try {
    await chrome.storage.local.set({ connectionCode });
    const result = await chrome.runtime.sendMessage({ type: 'sync' });
    if (!result?.ok) throw new Error(result?.error || '同步失败，请重试。');
    button.textContent = '立即同步';
    status.textContent = `已同步 ${result.count} 个标签页。以后会自动连接，无需重复配对。`;
  } catch (error) {
    status.textContent = error.message;
    status.classList.add('error');
  } finally { button.disabled = false; }
});
