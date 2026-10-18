import assert from 'node:assert/strict';
import test from 'node:test';
import { startBridge } from '../desktop/bridge.js';

test('本机同步需要连接码，不同浏览器 ID 隔离，同来源快照可替换', async (t) => {
  const updates = [];
  const bridge = await startBridge({ token: 'a'.repeat(32), port: 0, onUpdate: (sources) => updates.push(sources) });
  t.after(() => bridge.close());
  const send = (data, token = 'a'.repeat(32)) => fetch(`${bridge.url}/tabs`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const chrome = { sourceId: 'chrome-profile', browser: 'Chrome', tabs: [{ id: 1, title: '书 第10章', url: 'https://example.com/10' }] };
  assert.equal((await send(chrome, 'wrong')).status, 401);
  assert.equal(updates.length, 0);
  assert.equal((await send(chrome)).status, 200);
  assert.equal((await send({ ...chrome, sourceId: 'edge-profile', browser: 'Edge' })).status, 200);
  assert.equal(bridge.snapshot().length, 2);
  assert.notEqual(bridge.snapshot()[0].tabs[0].id, bridge.snapshot()[1].tabs[0].id);
  assert.equal(bridge.snapshot()[0].tabs[0].openedAt, null);
  assert.equal((await send({ ...chrome, tabs: [] })).status, 200);
  assert.equal(bridge.snapshot()[0].tabs.length, 0);
  assert.equal(bridge.snapshot()[1].tabs.length, 1);
});

test('网页来源、恶意字段、重复 ID 和过量数据被拒绝且不污染已同步数据', async (t) => {
  const bridge = await startBridge({ token: 'b'.repeat(32), port: 0 });
  t.after(() => bridge.close());
  const post = (body, extra = {}) => fetch(`${bridge.url}/tabs`, { method: 'POST',
    headers: { Authorization: `Bearer ${'b'.repeat(32)}`, 'Content-Type': 'application/json', ...extra }, body });
  const valid = { sourceId: 'profile', browser: 'Chrome', tabs: [{ id: 1, title: '正常标题' }] };
  assert.equal((await post(JSON.stringify(valid), { Origin: 'https://example.com' })).status, 403);
  assert.equal((await post('{bad json')).status, 400);
  for (const invalid of [null, { ...valid, sourceId: {} }, { ...valid, sourceId: 123 }, { ...valid, browser: 'Other' },
    { ...valid, tabs: [null] }, { ...valid, tabs: [valid.tabs[0], valid.tabs[0]] },
    { ...valid, tabs: [{ id: 1, title: 'a'.repeat(2049) }] },
    { ...valid, tabs: [{ id: 1, title: 'x', url: 'relative/path' }] }]) {
    assert.equal((await post(JSON.stringify(invalid))).status, 400);
  }
  assert.equal((await post(JSON.stringify({ ...valid, padding: 'x'.repeat(2 * 1024 * 1024) }))).status, 413);
  assert.deepEqual(bridge.snapshot(), []);
  assert.equal((await post(JSON.stringify(valid))).status, 200);
  const snapshot = bridge.snapshot();
  snapshot[0].tabs.length = 0;
  assert.equal(bridge.snapshot()[0].tabs.length, 1);
});

test('关闭只发给对应浏览器会话，结果需认证且匹配请求；离线、过期快照和旧扩展不执行', async (t) => {
  const token = 'e'.repeat(32);
  const bridge = await startBridge({ token, port: 0 });
  t.after(() => bridge.close());
  const post = (path, data, code = token) => fetch(`${bridge.url}${path}`, { method: 'POST',
    headers: { Authorization: `Bearer ${code}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const source = { sourceId: 'chrome', sessionId: 'session-one', browser: 'Chrome',
    tabs: [{ id: 1, title: '书 第1章', url: 'https://example.com/1' }] };
  await post('/tabs', source);
  assert.equal(bridge.snapshot()[0].connected, false);
  await post('/tabs', { ...source, sourceId: 'edge', sessionId: 'session-two', browser: 'Edge' });
  const selected = bridge.snapshot().flatMap((item) => item.tabs);
  assert.equal((await post('/commands', source, 'wrong')).status, 401);
  assert.equal((await post('/commands', { ...source, sessionId: 'old' })).status, 409);
  assert.equal((await post('/close', source)).status, 404, 'HTTP 不提供发起关闭的接口');
  const poll = await post('/commands', source);
  assert.equal(bridge.snapshot()[0].connected, true);
  const closing = bridge.closeTabs(selected);
  const { command } = await poll.json();
  assert.equal(bridge.snapshot()[0].connected, true, '执行关闭期间仍视为已连接');
  assert.equal(command.type, 'close-tabs');
  assert.equal(command.sessionId, source.sessionId);
  assert.deepEqual(command.tabs, source.tabs);
  const reply = { ...source, requestId: command.requestId, results: [{ id: 1, status: 'closed' }] };
  assert.equal((await post('/results', { ...reply, sourceId: 'edge' })).status, 409);
  assert.equal((await post('/results', { ...reply, results: [{ id: 2, status: 'closed' }] })).status, 400);
  assert.equal((await post('/results', reply)).status, 200);
  const results = await closing;
  assert.equal(results[0].id, 'chrome:1');
  assert.equal(results[0].status, 'closed');
  assert.equal(results[1].id, 'edge:1');
  assert.equal(results[1].status, 'skipped');
  assert.equal((await post('/results', reply)).status, 409, '已完成指令不能重放结果');
  await post('/tabs', { ...source, tabs: [{ ...source.tabs[0], url: 'https://example.com/new' }] });
  assert.equal((await bridge.closeTabs([selected[0]]))[0].status, 'skipped');
  await post('/tabs', { ...source, sessionId: 'new-session' });
  assert.match((await bridge.closeTabs([selected[0]]))[0].error, /会话已变化/);
  await post('/tabs', { ...source, sessionId: undefined });
  const outdated = (await bridge.closeTabs(bridge.snapshot()[0].tabs))[0];
  assert.equal(outdated.status, 'skipped');
  assert.match(outdated.error, /扩展版本过旧.*打开扩展文件夹.*替换原扩展目录.*重新加载.*再同步.*仅重新同步不会升级扩展/);
  await assert.rejects(bridge.closeTabs([selected[0], selected[0]]), /关闭清单无效/);
});

test('关闭超时报告结果未知，过期指令不会留待扩展稍后执行', async (t) => {
  const token = 'f'.repeat(32);
  const bridge = await startBridge({ token, port: 0 });
  t.after(() => bridge.close());
  const source = { sourceId: 'chrome', sessionId: 'session', browser: 'Chrome',
    tabs: [{ id: 1, title: '书', url: 'https://example.com/1' }] };
  const post = (path, data) => fetch(`${bridge.url}${path}`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  await post('/tabs', source);
  const poll = await post('/commands', source);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const closing = bridge.closeTabs(bridge.snapshot()[0].tabs);
  t.mock.timers.tick(30000);
  const results = await closing;
  t.mock.timers.reset();
  assert.equal(results[0].status, 'unknown');
  const { command } = await poll.json();
  assert.equal((await post('/results', { ...source, requestId: command.requestId, results: [{ id: 1, status: 'closed' }] })).status, 409);
});

test('连接状态随指令连接建立和断开更新，不冒充新标签页快照', async (t) => {
  const updates = [];
  const token = 'f'.repeat(32);
  const bridge = await startBridge({ token, port: 0, onUpdate: (sources) => updates.push(sources) });
  const stop = new AbortController();
  t.after(async () => { stop.abort(); await bridge.close(); });
  const source = { sourceId: 'profile', sessionId: 'session', browser: 'Chrome', tabs: [] };
  const post = (path, data, signal) => fetch(`${bridge.url}${path}`, { method: 'POST', signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  await post('/tabs', source);
  const revision = bridge.snapshot()[0].revision;
  assert.equal(bridge.snapshot()[0].connected, false);
  const poll = await post('/commands', source, stop.signal);
  assert.equal(bridge.snapshot()[0].connected, true);
  const body = poll.json();
  stop.abort();
  await assert.rejects(body);
  for (let i = 0; bridge.snapshot()[0].connected && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(bridge.snapshot()[0].connected, false);
  assert.equal(bridge.snapshot()[0].revision, revision);
  assert.equal(updates.at(-1)[0].connected, false);
  await post('/tabs', source);
  assert.ok(bridge.snapshot()[0].revision > revision, '只有标签页同步递增快照编号');
});

test('定位核对能力、来源与会话，定位回执不能冒充关闭，离线不排队', async (t) => {
  const token = 'a'.repeat(32);
  const bridge = await startBridge({ token, port: 0 });
  t.after(() => bridge.close());
  const post = (path, data) => fetch(`${bridge.url}${path}`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const source = { sourceId: 'chrome', sessionId: 'session', browser: 'Chrome',
    tabs: [{ id: 1, title: '示例', url: 'https://example.com' }] };
  await post('/tabs', source);
  assert.match((await bridge.focusTab(bridge.snapshot()[0].tabs[0])).error, /扩展 0.4.0.*重新加载/);
  assert.equal((await post('/tabs', { ...source, canFocus: 'yes' })).status, 400);
  await post('/tabs', { ...source, canFocus: true });
  const tab = bridge.snapshot()[0].tabs[0];
  assert.match((await bridge.focusTab(tab)).error, /未连接/);
  assert.match((await bridge.focusTab({ ...tab, sessionId: 'old' })).error, /会话已变化/);
  assert.equal((await post('/focus', tab)).status, 404, 'HTTP 不提供发起定位的入口');
  const poll = await post('/commands', source);
  const focus = bridge.focusTab(tab);
  const { command } = await poll.json();
  assert.equal(command.type, 'focus-tab');
  assert.deepEqual(command.tabs, source.tabs);
  const reply = { ...source, requestId: command.requestId, results: [{ id: 1, status: 'focused' }] };
  assert.equal((await post('/results', { ...reply, results: [{ id: 1, status: 'closed' }] })).status, 400);
  assert.equal((await post('/results', { ...reply, sourceId: 'edge' })).status, 409);
  assert.equal((await post('/results', reply)).status, 200);
  assert.equal((await focus).status, 'focused');
  assert.equal((await post('/results', reply)).status, 409);
  assert.equal(bridge.snapshot()[0].tabs.length, 1, '定位不删除快照标签页');
});

test('扩展版本按来源保留，旧扩展记为未知，恶意或无效版本不能污染快照', async (t) => {
  const token = 'b'.repeat(32);
  const bridge = await startBridge({ token, port: 0 });
  t.after(() => bridge.close());
  const source = { sourceId: 'chrome', browser: 'Chrome', tabs: [] };
  const post = data => fetch(`${bridge.url}/tabs`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  assert.equal((await post(source)).status, 200);
  assert.equal(bridge.snapshot()[0].extensionVersion, null);
  assert.equal((await post({ ...source, extensionVersion: '0.5.0' })).status, 200);
  assert.equal((await post({ ...source, sourceId: 'edge', browser: 'Edge', extensionVersion: '0.4.0' })).status, 200);
  assert.deepEqual(bridge.snapshot().map(item => item.extensionVersion), ['0.5.0', '0.4.0']);
  for (const extensionVersion of [123, {}, [], '', '0.5.0<script>', '0.5.0-beta', '65536.0', '1.2.3.4.5', '1'.repeat(1000)]) {
    assert.equal((await post({ ...source, extensionVersion })).status, 400);
    assert.equal(bridge.snapshot()[0].extensionVersion, '0.5.0');
  }
  for (const extensionVersion of ['1', '0.5', '0.5.0.1', '65535.65535.65535.65535']) {
    assert.equal((await post({ ...source, extensionVersion })).status, 200);
    assert.equal(bridge.snapshot()[0].extensionVersion, extensionVersion);
  }
});
