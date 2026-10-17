import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const limit = 2 * 1024 * 1024;

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
  if (!data || typeof data.sourceId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(data.sourceId) || !['Chrome', 'Edge'].includes(data.browser)
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
      browser: data.browser, sourceId: data.sourceId };
  });
  return { sourceId: data.sourceId, browser: data.browser, tabs, receivedAt: Date.now() };
}

export async function startBridge({ token, port = 37843, onUpdate = () => {} }) {
  if (!/^[a-f0-9]{32}$/.test(token)) throw new TypeError('连接码必须是 32 位随机十六进制字符串。');
  const sources = new Map();
  const snapshot = () => structuredClone([...sources.values()]);
  const server = createServer(async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    const origin = request.headers.origin;
    if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return send(403, { error: '不允许网页连接。' });
    if (request.method !== 'POST' || request.url !== '/tabs') return send(404, { error: '接口不存在。' });
    const provided = Buffer.from(request.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      request.resume();
      return send(401, { error: '连接码不正确，请复制桌面端连接码。' });
    }
    if (!request.headers['content-type']?.startsWith('application/json')) return send(415, { error: '需要 JSON 数据。' });
    try {
      const source = validateSnapshot(JSON.parse(await readBody(request)));
      sources.set(source.sourceId, source);
      onUpdate(snapshot());
      send(200, { ok: true, count: source.tabs.length });
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
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
