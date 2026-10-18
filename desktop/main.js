import { app, BrowserWindow, clipboard, dialog, ipcMain, net, protocol, session, shell } from 'electron';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyzeTabs } from '../src/core.js';
import { startBridge } from './bridge.js';
import { loadIgnoreRules, saveIgnoreRules } from './ignore-rules.js';

const directory = dirname(fileURLToPath(import.meta.url));
const pageURL = 'tabtidy://app/index.html';
protocol.registerSchemesAsPrivileged([{ scheme: 'tabtidy', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let window;
let bridge;
let closingTabs = false;

async function start() {
  await app.whenReady();
  const configPath = join(app.getPath('userData'), 'connection.json');
  let token;
  try {
    ({ token } = JSON.parse(await readFile(configPath, 'utf8')));
    if (!/^[a-f0-9]{32}$/.test(token)) throw new Error('连接配置无效，请保留配置文件并联系开发者。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    token = randomBytes(16).toString('hex');
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ token }), { mode: 0o600, flag: 'wx' });
  }
  const rulesPath = join(app.getPath('userData'), 'ignored-names.json');
  let ignoreRules = await loadIgnoreRules(rulesPath);
  bridge = await startBridge({ token, onUpdate: (sources) => {
    if (window && !window.isDestroyed()) window.webContents.send('sources-updated', sources);
  } });
  const files = new Map([
    ['/index.html', join(directory, 'index.html')], ['/style.css', join(directory, 'style.css')],
    ['/renderer.js', join(directory, 'renderer.js')], ['/core.js', join(directory, '../src/core.js')],
    ['/title-rules.js', join(directory, '../src/title-rules.js')],
  ]);
  protocol.handle('tabtidy', (request) => {
    const url = new URL(request.url);
    const path = url.host === 'app' && files.get(url.pathname);
    return path ? net.fetch(pathToFileURL(path).href) : new Response('', { status: 404 });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const extensionPath = app.isPackaged ? join(process.resourcesPath, 'browser-extension') : join(directory, '../browser-extension');
  const versions = {
    desktop: JSON.parse(await readFile(join(directory, '../package.json'), 'utf8')).version,
    extension: JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8')).version,
  };
  const handle = (channel, callback) => ipcMain.handle(channel, (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame?.url !== pageURL) throw new Error('请求来源无效。');
    return callback(...args);
  });
  handle('get-state', () => ({ token, sources: bridge.snapshot(), ignoreRules, versions }));
  handle('save-ignored-names', async (rules) => {
    if (closingTabs) return { ok: false, error: '正在关闭标签页，请稍后再保存设置。' };
    try {
      ignoreRules = await saveIgnoreRules(rulesPath, rules);
      return { ok: true, rules: ignoreRules };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  handle('copy-code', () => clipboard.writeText(token));
  handle('extension-folder', async () => {
    const error = await shell.openPath(extensionPath);
    if (error) throw new Error(error);
  });
  let focusingTab = false;
  handle('focus-tab', async (tab) => {
    if (closingTabs || focusingTab) throw new Error('正在执行浏览器操作，请稍候。');
    focusingTab = true;
    try { return await bridge.focusTab(tab); }
    finally { focusingTab = false; }
  });
  handle('close-tabs', async (tabs) => {
    if (closingTabs || focusingTab) throw new Error('正在执行浏览器操作，请稍候。');
    if (!Array.isArray(tabs) || !tabs.length || tabs.length > 5000) throw new Error('关闭清单无效。');
    analyzeTabs(tabs);
    closingTabs = true;
    try {
      const preview = tabs.slice(0, 20).map((tab) => `${tab.browser} · ${tab.title || '无标题'}\n${tab.url || '网址未知'}`).join('\n\n');
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning', title: '确认关闭标签页', message: `关闭已勾选的 ${tabs.length} 个标签页？`,
        detail: `关闭可能丢失页面中未保存的内容。\n\n${preview}${tabs.length > 20 ? `\n\n另有 ${tabs.length - 20} 项，请在主界面核对完整清单。` : ''}`,
        buttons: ['取消', '关闭已选标签页'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (response !== 1) return { canceled: true, results: [] };
      return { canceled: false, results: await bridge.closeTabs(tabs) };
    } finally { closingTabs = false; }
  });
  window = new BrowserWindow({ width: 1180, height: 800, minWidth: 980, minHeight: 640, title: 'TabTidy',
    backgroundColor: '#ffffff', show: false, autoHideMenuBar: true,
    webPreferences: { preload: join(directory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  await window.loadURL(pageURL);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { window.restore(); window.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { if (bridge) void bridge.close(); });
  start().catch((error) => {
    dialog.showErrorBox('TabTidy 无法启动', error.code === 'EADDRINUSE'
      ? '本机同步端口 37843 被占用。请关闭其他 TabTidy 实例后重试。' : error.message);
    app.quit();
  });
}
