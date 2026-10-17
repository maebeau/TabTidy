const assert = require('node:assert/strict');
const { app, BrowserWindow, dialog } = require('electron');
const { mkdtempSync } = require('node:fs');
const { mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const temporary = mkdtempSync(join(tmpdir(), 'tabtidy-desktop-'));
app.setPath('userData', temporary);
const timeout = setTimeout(() => { console.error('桌面测试超时'); app.exit(1); }, 30000);

async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('桌面界面未达到预期状态');
}

(async () => {
  const ready = new Promise((resolve) => app.once('browser-window-created', (_event, window) => {
    window.webContents.once('did-finish-load', () => resolve(window));
  }));
  await import('../desktop/main.js');
  const window = await ready;
  const js = (code) => window.webContents.executeJavaScript(code);
  await waitFor(() => js("Boolean(document.getElementById('connection-code').value)"));
  const token = await js('window.tabTidy.getState().then(state => state.token)');
  const post = async (sourceId, browser, tabs) => {
    const response = await fetch('http://127.0.0.1:37843/tabs', { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: `chrome-extension://${'a'.repeat(32)}` },
      body: JSON.stringify({ sourceId, browser, tabs }),
    });
    assert.equal(response.status, 200);
  };
  const tabs = [
    { id: 10, title: '星河旅行 1-20 整理版', url: 'https://example.com/novel/20' },
    { id: 11, title: '星河旅行 1-30 更新版', url: 'https://example.com/novel/30' },
  ];
  await post('chrome-test', 'Chrome', tabs);
  await waitFor(() => js("document.getElementById('selected-count').textContent === '1'"));
  assert.equal(await js("document.querySelectorAll('.group').length"), 1);
  await js("document.querySelector('.tab-row input').click()");
  await post('chrome-test', 'Chrome', tabs);
  await waitFor(() => js("document.getElementById('selected-count').textContent === '2'"));
  await js("document.getElementById('sort-by').value='time'; document.getElementById('sort-by').dispatchEvent(new Event('change'))");
  assert.equal(await js("document.getElementById('selected-count').textContent"), '0');
  await js("document.getElementById('sort-by').value='natural'; document.getElementById('direction').value='asc'; document.getElementById('sort-by').dispatchEvent(new Event('change'))");
  assert.equal(await js("document.querySelector('.tab-title').textContent"), tabs[0].title);
  const output = join(temporary, 'selected.json');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: output });
  await js("document.getElementById('export').click()");
  await waitFor(() => js("document.getElementById('notice').textContent.includes('已导出')"));
  assert.equal(JSON.parse(await readFile(output, 'utf8'))[0].title, tabs[1].title);
  await post('edge-test', 'Edge', [
    { id: 10, title: '山海故事 1-9 完整版', url: 'https://example.com/other/9' },
    { id: 11, title: '乙分享 山海故事', url: 'https://example.com/other/10' },
  ]);
  await waitFor(() => js("document.querySelectorAll('.group').length === 2"));
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/desktop-preview.png', (await window.webContents.capturePage()).toPNG());
  await post('edge-test', 'Edge', [
    { id: 10, title: '<img src=x onerror="window.injected=1">', url: 'https://example.com/same' },
    { id: 11, title: '安全标题', url: 'https://example.com/same' },
  ]);
  await waitFor(() => js("document.getElementById('groups').textContent.includes('<img')"));
  assert.equal(await js("document.querySelectorAll('#groups img').length"), 0);
  assert.equal(await js('window.injected'), undefined);
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  clearTimeout(timeout);
  console.log('桌面验证通过：双浏览器同步、分组、勾选保留、排序、导出和恶意标题文本处理。');
  await rm(temporary, { recursive: true, force: true });
  app.exit(0);
})().catch((error) => { console.error(error); app.exit(1); });
