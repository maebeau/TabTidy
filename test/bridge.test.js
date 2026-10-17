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
