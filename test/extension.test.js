import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { startBridge } from '../desktop/bridge.js';

test('扩展通过浏览器消息接口读取普通窗口并发送到本机，保留来源标识', async (t) => {
  const token = 'c'.repeat(32);
  const bridge = await startBridge({ token, port: 0 });
  const stop = new AbortController();
  t.after(async () => { stop.abort(); await bridge.close(); });
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
      const path = new URL(url).pathname;
      assert.ok(['/tabs', '/commands', '/results'].includes(path));
      return fetch(`${bridge.url}${path}`, { ...options, signal: AbortSignal.any([options.signal, stop.signal]) });
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

test('扩展核对会话、网址和标题后关闭，跳过跳转及隐身页面，逐项报告失败并同步剩余标签页', async (t) => {
  const token = 'd'.repeat(32);
  const bridge = await startBridge({ token, port: 0 });
  const stop = new AbortController();
  t.after(async () => { stop.abort(); await bridge.close(); });
  const stored = { connectionCode: token, sourceId: 'chrome-test' };
  const live = new Map(Array.from({ length: 8 }, (_, index) => [index + 1,
    { id: index + 1, title: `书 第${index + 1}章`, url: `https://example.com/${index + 1}`, incognito: false }]));
  const removed = [];
  let connected;
  const ready = new Promise((resolve) => { connected = resolve; });
  const event = { addListener: () => {} };
  const chrome = {
    runtime: { id: 'a'.repeat(32), onMessage: event, onStartup: event },
    storage: { local: { get: async () => ({ ...stored }), set: async (values) => Object.assign(stored, values) } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabs: { query: async () => [...live.values()].map((tab) => ({ ...tab })),
      get: async (id) => { if (!live.has(id)) throw new Error('No tab with id'); return { ...live.get(id) }; },
      remove: async (id) => { if (id === 6) throw new Error('Browser refused'); if (id === 8) return; removed.push(id); live.delete(id); },
      onCreated: event, onRemoved: event, onUpdated: event },
  };
  const context = vm.createContext({ chrome, crypto: webcrypto, navigator: { userAgent: 'Windows Chrome/140' }, AbortSignal, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      const path = new URL(url).pathname;
      const response = await fetch(`${bridge.url}${path}`, { ...options, signal: AbortSignal.any([options.signal, stop.signal]) });
      if (path === '/commands' && response.ok) connected();
      return response;
    },
  });
  vm.runInContext(await readFile(new URL('../browser-extension/background.js', import.meta.url), 'utf8'), context);
  await ready;
  const selected = bridge.snapshot()[0].tabs;
  live.get(2).url = 'https://example.com/new';
  live.get(3).title = '已经切换的页面';
  live.get(4).pendingUrl = 'https://example.com/loading';
  live.get(5).incognito = true;
  live.delete(7);
  const results = await bridge.closeTabs(selected);
  assert.deepEqual(removed, [1]);
  assert.deepEqual(results.map((item) => item.status), ['closed', 'skipped', 'skipped', 'skipped', 'skipped', 'failed', 'skipped', 'failed']);
  assert.deepEqual(bridge.snapshot()[0].tabs.map((tab) => tab.id), ['chrome-test:2', 'chrome-test:3', 'chrome-test:4', 'chrome-test:6', 'chrome-test:8']);
  const expired = await vm.runInContext('closeTabs({ type: "close-tabs", sessionId, requestId: crypto.randomUUID(), expiresAt: Date.now() - 1, tabs: [{ id: 2, title: "书 第2章", url: "https://example.com/new" }] })', context);
  assert.equal(expired[0].status, 'skipped');
  await assert.rejects(vm.runInContext('closeTabs({ type: "close-tabs", sessionId: "old-session" })', context), /关闭指令无效/);
  assert.deepEqual(removed, [1], '无效指令不能触发额外关闭');
});
