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
  await post('/tabs', { ...source, sourceId: 'edge', sessionId: 'session-two', browser: 'Edge' });
  const selected = bridge.snapshot().flatMap((item) => item.tabs);
  assert.equal((await post('/commands', source, 'wrong')).status, 401);
  assert.equal((await post('/commands', { ...source, sessionId: 'old' })).status, 409);
  assert.equal((await post('/close', source)).status, 404, 'HTTP 不提供发起关闭的接口');
  const poll = await post('/commands', source);
  const closing = bridge.closeTabs(selected);
  const { command } = await poll.json();
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
