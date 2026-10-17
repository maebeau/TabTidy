import { app, BrowserWindow, clipboard, dialog, ipcMain, net, protocol, session, shell } from 'electron';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyzeTabs } from '../src/core.js';
import { startBridge } from './bridge.js';

const directory = dirname(fileURLToPath(import.meta.url));
const pageURL = 'tabtidy://app/index.html';
protocol.registerSchemesAsPrivileged([{ scheme: 'tabtidy', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let window;
let bridge;

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
  bridge = await startBridge({ token, onUpdate: (sources) => {
    if (window && !window.isDestroyed()) window.webContents.send('sources-updated', sources);
  } });
  const files = new Map([
    ['/index.html', join(directory, 'index.html')], ['/style.css', join(directory, 'style.css')],
    ['/renderer.js', join(directory, 'renderer.js')], ['/core.js', join(directory, '../src/core.js')],
  ]);
  protocol.handle('tabtidy', (request) => {
    const url = new URL(request.url);
    const path = url.host === 'app' && files.get(url.pathname);
    return path ? net.fetch(pathToFileURL(path).href) : new Response('', { status: 404 });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const extensionPath = app.isPackaged ? join(process.resourcesPath, 'browser-extension') : join(directory, '../browser-extension');
  const handle = (channel, callback) => ipcMain.handle(channel, (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame?.url !== pageURL) throw new Error('请求来源无效。');
    return callback(...args);
  });
  handle('get-state', () => ({ token, sources: bridge.snapshot() }));
  handle('copy-code', () => clipboard.writeText(token));
  handle('extension-folder', async () => {
    const error = await shell.openPath(extensionPath);
    if (error) throw new Error(error);
  });
  handle('export-tabs', async (tabs) => {
    if (!Array.isArray(tabs) || tabs.length > 5000) throw new Error('导出清单无效。');
    analyzeTabs(tabs);
    const { canceled, filePath } = await dialog.showSaveDialog(window, {
      title: '导出已选标签页', defaultPath: 'TabTidy-已选标签页.json', filters: [{ name: 'JSON 清单', extensions: ['json'] }],
    });
    if (canceled || !filePath) return false;
    await writeFile(filePath, JSON.stringify(tabs, null, 2), 'utf8');
    return true;
  });
  window = new BrowserWindow({ width: 1180, height: 800, minWidth: 980, minHeight: 640, title: 'TabTidy',
    backgroundColor: '#f6f7f4', show: false, autoHideMenuBar: true,
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
