import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { startBridge } from '../desktop/bridge.js';

const manifest = JSON.parse(await readFile(new URL('../browser-extension/manifest.json', import.meta.url), 'utf8'));

async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('扩展未达到预期连接状态');
}

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
    alarms: { get: async () => undefined, create: async () => {}, onAlarm: event },
    runtime: { getManifest: () => manifest, id, onMessage: { addListener: (listener) => { onMessage = listener; } }, onStartup: event },
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
  assert.equal(first.extensionVersion, manifest.version, '上报实际运行扩展的 manifest 版本');
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
    alarms: { get: async () => undefined, create: async () => {}, onAlarm: event },
    runtime: { getManifest: () => manifest, id: 'a'.repeat(32), onMessage: event, onStartup: event },
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
  const expired = await vm.runInContext('executeCommand({ type: "close-tabs", sessionId, requestId: crypto.randomUUID(), expiresAt: Date.now() - 1, tabs: [{ id: 2, title: "书 第2章", url: "https://example.com/new" }] })', context);
  assert.equal(expired[0].status, 'skipped');
  await assert.rejects(vm.runInContext('executeCommand({ type: "close-tabs", sessionId: "old-session" })', context), /浏览器指令无效/);
  assert.deepEqual(removed, [1], '无效指令不能触发额外关闭');
});

test('首次配对后通过浏览器闹钟自动重连，桌面与扩展后台重启后保留来源且不重放关闭', async (t) => {
  const token = 'e'.repeat(32);
  let bridge;
  let onAlarm;
  let alarm;
  let alarmCreates = 0;
  const stored = {};
  const stops = [];
  const removed = [];
  const live = new Map([1, 2].map((id) => [id, { id, title: `示例书 第${id}章`, url: `https://example.com/${id}` }]));
  const event = { addListener: () => {} };
  const chrome = {
    runtime: { getManifest: () => manifest, id: 'a'.repeat(32), onMessage: event, onStartup: event },
    storage: { local: { get: async () => ({ ...stored }), set: async (values) => Object.assign(stored, values) } },
    alarms: {
      get: async () => alarm,
      create: async (name, options) => { alarm = { name, ...options }; alarmCreates++; },
      onAlarm: { addListener: (listener) => { onAlarm = listener; } },
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabs: {
      query: async () => [...live.values()],
      get: async (id) => { if (!live.has(id)) throw new Error('No tab'); return { ...live.get(id) }; },
      remove: async (id) => { removed.push(id); live.delete(id); },
      onCreated: event, onRemoved: event, onUpdated: event,
    },
  };
  const script = await readFile(new URL('../browser-extension/background.js', import.meta.url), 'utf8');
  const boot = () => {
    const stop = new AbortController();
    stops.push(stop);
    const context = vm.createContext({ chrome, crypto: webcrypto, navigator: { userAgent: 'Chrome' }, AbortSignal, setTimeout, clearTimeout,
      fetch: (url, options) => {
        if (!bridge) throw new TypeError('Failed to fetch');
        return fetch(`${bridge.url}${new URL(url).pathname}`, { ...options, signal: AbortSignal.any([options.signal, stop.signal]) });
      },
    });
    vm.runInContext(script, context);
    return { context, stop };
  };
  t.after(async () => { stops.forEach((stop) => stop.abort()); if (bridge) await bridge.close(); });
  let worker = boot();
  await vm.runInContext('pending', worker.context);
  assert.equal(alarmCreates, 0, '未配对时不注册重连闹钟');
  stored.connectionCode = token;
  await assert.rejects(vm.runInContext('queueSync()', worker.context), /自动重连/);
  assert.equal(alarm.periodInMinutes, 0.5);
  const sourceId = stored.sourceId;
  bridge = await startBridge({ token, port: 0 });
  onAlarm({ name: alarm.name });
  await waitFor(() => bridge.snapshot()[0]?.connected);
  assert.equal(bridge.snapshot()[0].sourceId, sourceId);
  assert.equal(bridge.snapshot()[0].tabs.length, 2);
  assert.equal(stored.lastError, '');

  const previous = bridge;
  bridge = undefined;
  await previous.close();
  await waitFor(() => vm.runInContext('!polling', worker.context));
  bridge = await startBridge({ token, port: 0 });
  assert.deepEqual(bridge.snapshot(), []);
  onAlarm({ name: alarm.name });
  await waitFor(() => bridge.snapshot()[0]?.connected);
  assert.equal(bridge.snapshot()[0].sourceId, sourceId, '桌面重启无需重新配对');
  const previousSession = bridge.snapshot()[0].sessionId;
  worker.stop.abort();
  await waitFor(() => vm.runInContext('!polling', worker.context));
  alarm = undefined;
  worker = boot();
  await waitFor(() => bridge.snapshot()[0]?.sessionId !== previousSession && bridge.snapshot()[0]?.connected);
  assert.equal(bridge.snapshot().length, 1, '后台重启不新增重复来源');
  assert.equal(bridge.snapshot()[0].sourceId, sourceId);
  assert.equal(alarmCreates, 2, '后台启动发现闹钟丢失时重新创建');
  const results = await bridge.closeTabs(bridge.snapshot()[0].tabs);
  assert.deepEqual(results.map((result) => result.status), ['closed', 'closed']);
  assert.deepEqual(removed, [1, 2]);
  onAlarm({ name: alarm.name });
  await vm.runInContext('pending', worker.context);
  assert.deepEqual(removed, [1, 2], '恢复与重试不会重放已确认的关闭');
  assert.equal(stored.connectionCode, token);
});

test('定位按浏览器来源激活原标签页及窗口，恢复最小化，拒绝变化、隐身、失效与过期目标', async (t) => {
  const token = 'f'.repeat(32);
  const bridge = await startBridge({ token, port: 0 });
  const stops = [];
  t.after(async () => { stops.forEach(stop => stop.abort()); await bridge.close(); });
  const calls = [];
  const workers = [];
  for (const browser of ['Chrome', 'Edge']) {
    const stop = new AbortController(); stops.push(stop);
    const stored = { connectionCode: token, sourceId: browser.toLowerCase() };
    const tab = { id: 1, windowId: browser === 'Chrome' ? 10 : 20, title: '同名书', url: 'https://example.com/book' };
    let windowState = browser === 'Chrome' ? 'maximized' : 'minimized';
    const event = { addListener: () => {} };
    const chrome = {
      runtime: { getManifest: () => manifest, id: 'a'.repeat(32), onMessage: event, onStartup: event },
      storage: { local: { get: async () => stored, set: async values => Object.assign(stored, values) } },
      alarms: { get: async () => ({}), onAlarm: event },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      tabs: { query: async () => [{ ...tab }], get: async () => { if (tab.missing) throw new Error('No tab'); return { ...tab }; },
        update: async (id, options) => { calls.push({ browser, tabId: id, ...options }); },
        remove: async () => assert.fail('定位不能关闭标签页'), onCreated: event, onRemoved: event, onUpdated: event },
      windows: { get: async () => ({ state: windowState }), update: async (windowId, options) => {
        calls.push({ browser, windowId, ...options }); if (options.state) windowState = options.state;
        if (tab.failFocus) throw new Error('Window focus refused');
      } },
    };
    const context = vm.createContext({ chrome, crypto: webcrypto, navigator: { userAgent: browser === 'Edge' ? 'Edg/140' : 'Chrome' }, AbortSignal, setTimeout, clearTimeout,
      fetch: (url, options) => fetch(`${bridge.url}${new URL(url).pathname}`, { ...options, signal: AbortSignal.any([options.signal, stop.signal]) }),
    });
    vm.runInContext(await readFile(new URL('../browser-extension/background.js', import.meta.url), 'utf8'), context);
    workers.push({ context, tab });
  }
  await waitFor(() => bridge.snapshot().length === 2 && bridge.snapshot().every(source => source.connected));
  for (const browser of ['Chrome', 'Edge']) {
    const source = bridge.snapshot().find(source => source.browser === browser);
    assert.equal(source.canFocus, true);
    assert.equal((await bridge.focusTab(source.tabs[0])).status, 'focused');
    await waitFor(() => bridge.snapshot().every(source => source.connected));
  }
  assert.deepEqual(calls, [
    { browser: 'Chrome', tabId: 1, active: true }, { browser: 'Chrome', windowId: 10, focused: true },
    { browser: 'Edge', windowId: 20, state: 'normal' }, { browser: 'Edge', tabId: 1, active: true }, { browser: 'Edge', windowId: 20, focused: true },
  ]);
  const { context, tab } = workers[0];
  const run = (expires = 'Date.now()+30000') => vm.runInContext(`executeCommand({type:'focus-tab',sessionId,requestId:crypto.randomUUID(),expiresAt:${expires},tabs:[{id:1,title:'同名书',url:'https://example.com/book'}]})`, context);
  const before = calls.length;
  for (const change of [{ url: 'https://changed.example' }, { title: '变化' }, { incognito: true }, { pendingUrl: 'https://pending.example' }, { missing: true }]) {
    const original = { ...tab }; Object.assign(tab, change);
    assert.equal((await run())[0].status, 'skipped');
    for (const key of Object.keys(tab)) delete tab[key]; Object.assign(tab, original);
  }
  assert.equal((await run('Date.now()-1'))[0].status, 'skipped');
  assert.equal(calls.length, before);
  await assert.rejects(vm.runInContext("executeCommand({type:'focus-tab',sessionId:'old'})", context), /指令无效/);
  tab.failFocus = true;
  assert.equal((await run())[0].status, 'failed');
});
