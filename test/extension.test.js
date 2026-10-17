import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { startBridge } from '../desktop/bridge.js';

test('扩展通过浏览器消息接口读取普通窗口并发送到本机，保留来源标识', async (t) => {
  const token = 'c'.repeat(32);
  const bridge = await startBridge({ token, port: 0 });
  t.after(() => bridge.close());
  const stored = { connectionCode: token };
  let onMessage;
  const event = { addListener: () => {} };
  const id = 'a'.repeat(32);
  const chrome = {
    runtime: { id, onMessage: { addListener: (listener) => { onMessage = listener; } }, onStartup: event },
    storage: { local: { get: async () => ({ ...stored }), set: async (values) => Object.assign(stored, values) } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabs: { query: async () => [
      { id: 1, title: '书 第1章', url: 'https://example.com/1', incognito: false },
      { id: 2, title: '隐身窗口', url: 'https://example.com/private', incognito: true },
    ], onCreated: event, onRemoved: event, onUpdated: event },
  };
  vm.runInNewContext(await readFile(new URL('../browser-extension/background.js', import.meta.url), 'utf8'), {
    chrome, crypto: webcrypto, navigator: { userAgent: 'Windows Edg/140' }, AbortSignal, setTimeout, clearTimeout,
    fetch: (url, options) => {
      assert.equal(url, 'http://127.0.0.1:37843/tabs');
      return fetch(`${bridge.url}/tabs`, options);
    },
  });
  const sync = () => new Promise((resolve) => onMessage({ type: 'sync' }, { id }, resolve));
  assert.equal((await sync()).ok, true);
  const first = bridge.snapshot()[0];
  assert.equal(first.browser, 'Edge');
  assert.equal(first.tabs.length, 1);
  assert.equal(first.tabs[0].url, 'https://example.com/1');
  assert.equal(first.tabs[0].openedAt, null);
  assert.equal((await sync()).ok, true);
  assert.equal(bridge.snapshot().length, 1);
  assert.equal(bridge.snapshot()[0].sourceId, first.sourceId);
  stored.connectionCode = 'd'.repeat(32);
  assert.equal((await sync()).ok, false);
  assert.equal(bridge.snapshot()[0].tabs.length, 1);
});
