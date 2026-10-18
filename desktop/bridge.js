import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';

const limit = 2 * 1024 * 1024;
const identifier = /^[a-zA-Z0-9-]{1,64}$/;

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) reject(new RangeError('标签页数据超过 2 MB，请减少标签页数量后再同步。'));
      else chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function validateSnapshot(data) {
  if (!data || typeof data.sourceId !== 'string' || !identifier.test(data.sourceId) || !['Chrome', 'Edge'].includes(data.browser)
    || (data.canFocus != null && typeof data.canFocus !== 'boolean')
    || (data.sessionId != null && (typeof data.sessionId !== 'string' || !identifier.test(data.sessionId)))
    || !Array.isArray(data.tabs) || data.tabs.length > 5000) throw new TypeError('浏览器来源或标签页清单无效。');
  const ids = new Set();
  const tabs = data.tabs.map((tab) => {
    if (!tab || !Number.isSafeInteger(tab.id) || tab.id < 0 || ids.has(tab.id)
      || typeof tab.title !== 'string' || tab.title.length > 2048
      || (tab.url != null && (typeof tab.url !== 'string' || tab.url.length > 8192 || (tab.url && !URL.canParse(tab.url))))) {
      throw new TypeError('标签页字段无效、重复或过长。');
    }
    ids.add(tab.id);
    return { id: `${data.sourceId}:${tab.id}`, title: tab.title, url: tab.url || '', openedAt: null,
      browser: data.browser, sourceId: data.sourceId, sessionId: data.sessionId || null };
  });
  return { sourceId: data.sourceId, sessionId: data.sessionId || null, browser: data.browser, canFocus: data.canFocus === true, tabs, receivedAt: Date.now() };
}

export async function startBridge({ token, port = 37843, onUpdate = () => {} }) {
  if (!/^[a-f0-9]{32}$/.test(token)) throw new TypeError('连接码必须是 32 位随机十六进制字符串。');
  const sources = new Map();
  const polls = new Map();
  const commands = new Map();
  let revision = 0;
  const snapshot = () => structuredClone([...sources.values()].map((source) => ({ ...source,
    connected: Boolean(source.sessionId && (polls.get(source.sourceId)?.sessionId === source.sessionId
      || [...commands.values()].some((command) => command.sourceId === source.sourceId && command.sessionId === source.sessionId))),
  })));
  const runCommand = async (type, tabs) => {
    if (!Array.isArray(tabs) || !tabs.length || tabs.length > 5000
      || tabs.some((tab) => !tab || typeof tab.id !== 'string' || typeof tab.sourceId !== 'string'
        || typeof tab.title !== 'string' || typeof tab.url !== 'string')
      || new Set(tabs.map((tab) => tab.id)).size !== tabs.length) throw new TypeError('关闭清单无效。');
    const results = new Map();
    const bySource = new Map();
    for (const tab of tabs) {
      const source = sources.get(tab.sourceId);
      const current = source?.tabs.find((item) => item.id === tab.id);
      let error;
      if (!source?.sessionId) error = '扩展版本过旧，无法关闭标签页。请展开左侧“扩展与连接”，用“打开扩展文件夹”中的新版文件替换原扩展目录，在浏览器扩展管理页点击“重新加载”，再同步。仅重新同步不会升级扩展。';
      if (type === 'focus-tab' && !source?.canFocus) error = '定位需要扩展 0.4.0 或更新版本。请展开“扩展与连接”，打开扩展文件夹，替换原目录文件，在浏览器扩展管理页重新加载后再同步。';
      if (!error && source.sessionId !== tab.sessionId) error = '浏览器会话已变化，请重新同步后选择。';
      if (!error && (!current || current.url !== tab.url || current.title !== tab.title || !current.url)) error = '标签页已关闭、页面已变化或网址未知。';
      if (error) { results.set(tab.id, { id: tab.id, status: 'skipped', error }); continue; }
      if (!bySource.has(tab.sourceId)) bySource.set(tab.sourceId, []);
      bySource.get(tab.sourceId).push(current);
    }
    await Promise.all([...bySource].map(async ([sourceId, selected]) => {
      const poll = polls.get(sourceId);
      const finish = (status, error) => selected.forEach((tab) => results.set(tab.id, { id: tab.id, status, error }));
      if (!poll || poll.sessionId !== selected[0].sessionId) return finish('skipped', '浏览器扩展未连接，请点击扩展同步后重试。');
      await new Promise((resolve) => {
        const requestId = randomUUID();
        const complete = (outcomes) => {
          clearTimeout(timer);
          commands.delete(requestId);
          onUpdate(snapshot());
          if (outcomes) outcomes.forEach((item) => results.set(item.id, item));
          else finish('unknown', '未收到浏览器结果，请检查浏览器实际状态后再操作。');
          resolve();
        };
        const timer = setTimeout(() => complete(), 30000);
        commands.set(requestId, { type, sourceId, sessionId: poll.sessionId, selected, complete });
        poll.finish({ type, requestId, sessionId: poll.sessionId, expiresAt: Date.now() + 30000,
          tabs: selected.map((tab) => ({ id: Number(tab.id.slice(sourceId.length + 1)), title: tab.title, url: tab.url })) });
      });
    }));
    return tabs.map((tab) => results.get(tab.id));
  };
  const server = createServer(async (request, response) => {
    const send = (status, value) => {
      if (!response.headersSent) response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    const origin = request.headers.origin;
    if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return send(403, { error: '不允许网页连接。' });
    if (request.method !== 'POST' || !['/tabs', '/commands', '/results'].includes(request.url)) return send(404, { error: '接口不存在。' });
    const provided = Buffer.from(request.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      request.resume();
      return send(401, { error: '连接码不正确，请复制桌面端连接码。' });
    }
    if (!request.headers['content-type']?.startsWith('application/json')) return send(415, { error: '需要 JSON 数据。' });
    try {
      const data = JSON.parse(await readBody(request));
      if (request.url === '/tabs') {
        const source = { ...validateSnapshot(data), revision: ++revision };
        const poll = polls.get(source.sourceId);
        if (poll && poll.sessionId !== source.sessionId) poll.finish(null);
        sources.set(source.sourceId, source);
        onUpdate(snapshot());
        return send(200, { ok: true, count: source.tabs.length });
      }
      if (!data || typeof data.sourceId !== 'string' || typeof data.sessionId !== 'string'
        || !identifier.test(data.sourceId) || !identifier.test(data.sessionId)) throw new TypeError('浏览器连接无效。');
      if (request.url === '/commands') {
        if (sources.get(data.sourceId)?.sessionId !== data.sessionId) return send(409, { error: '浏览器会话已变化，请重新同步。' });
        polls.get(data.sourceId)?.finish(null);
        const poll = { sessionId: data.sessionId, finish: (command) => {
          clearTimeout(timer);
          if (polls.get(data.sourceId) === poll) { polls.delete(data.sourceId); onUpdate(snapshot()); }
          send(200, { command });
        } };
        const timer = setTimeout(() => poll.finish(null), 20000);
        polls.set(data.sourceId, poll);
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        response.flushHeaders();
        onUpdate(snapshot());
        response.once('close', () => {
          clearTimeout(timer);
          if (polls.get(data.sourceId) === poll) { polls.delete(data.sourceId); onUpdate(snapshot()); }
        });
        return;
      }
      const command = commands.get(data.requestId);
      if (!command || command.sourceId !== data.sourceId || command.sessionId !== data.sessionId) return send(409, { error: '浏览器请求已过期或来源不匹配。' });
      const expectedIds = new Set(command.selected.map((tab) => Number(tab.id.slice(data.sourceId.length + 1))));
      if (!Array.isArray(data.results) || data.results.length !== expectedIds.size || data.results.some((item) =>
        !item || !expectedIds.delete(item.id) || ![command.type === 'focus-tab' ? 'focused' : 'closed', 'skipped', 'failed'].includes(item.status)
        || (item.error != null && (typeof item.error !== 'string' || item.error.length > 512)))) throw new TypeError('浏览器结果无效。');
      command.complete(data.results.map((item) => ({ ...item, id: `${data.sourceId}:${item.id}` })));
      send(200, { ok: true });
    } catch (error) {
      send(error instanceof RangeError ? 413 : 400, { error: error.message });
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { url: `http://127.0.0.1:${server.address().port}`, snapshot,
    closeTabs: (tabs) => runCommand('close-tabs', tabs),
    focusTab: async (tab) => (await runCommand('focus-tab', [tab]))[0],
    close: () => {
      for (const poll of polls.values()) poll.finish(null);
      for (const command of commands.values()) command.complete();
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } };
}
