export function normalizeWebsite(value) {
  if (typeof value !== 'string') throw new TypeError('请输入网站域名。');
  const text = value.normalize('NFKC').trim().toLowerCase();
  const invalid = () => new TypeError('请输入完整域名（如 forum.example.com），不要包含协议、端口或路径。');
  if (!text || text.length > 253 || /[\\/?#@\s]/u.test(text) || (text.includes(':') && !(text.startsWith('[') && text.endsWith(']')))) throw invalid();
  let url;
  try { url = new URL(`https://${text}`); } catch { throw invalid(); }
  const host = url.hostname.replace(/\.$/, '');
  if (host.length > 253 || url.port || url.pathname !== '/' || (!host.startsWith('[')
    && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host))) throw invalid();
  return host;
}

export function normalizeIgnoredNamesByHost(rules) {
  if (!rules || typeof rules !== 'object' || Object.prototype.toString.call(rules) !== '[object Object]' || Object.keys(rules).length > 5000) {
    throw new TypeError('忽略词设置须为网站映射，最多支持 5000 个域名。');
  }
  const normalized = {};
  const hosts = new Set();
  for (const [website, names] of Object.entries(rules)) {
    const host = normalizeWebsite(website);
    if (hosts.has(host)) throw new TypeError(`网站域名重复：${host}`);
    hosts.add(host);
    const words = normalizeIgnoredNames(names);
    if (words.length) normalized[host] = words;
  }
  return normalized;
}

function normalizeIgnoredNames(names) {
  if (!Array.isArray(names) || names.length > 50) throw new TypeError('每条规则最多填写 50 个忽略词。');
  const unique = new Map();
  for (const name of names) {
    if (typeof name !== 'string') throw new TypeError('忽略词必须是文字。');
    const text = name.normalize('NFKC').trim();
    if (!text || text.length > 128 || /[\r\n]/u.test(text) || !/[\p{L}\p{N}]/u.test(text)) {
      throw new TypeError('每个忽略词须包含文字或数字、长度不超过 128 字符，且不能换行。');
    }
    if (!unique.has(text.toLowerCase())) unique.set(text.toLowerCase(), text);
  }
  return [...unique.values()];
}

export function normalizeIgnoreRules(rules) {
  if (!Array.isArray(rules) || rules.length > 100) throw new TypeError('最多保存 100 条忽略规则。');
  const hosts = new Map();
  return rules.map((rule) => {
    if (!rule || typeof rule.name !== 'string') throw new TypeError('请填写规则名称。');
    const name = rule.name.normalize('NFKC').trim();
    if (!name || name.length > 128 || /[\r\n]/u.test(name)) throw new TypeError('规则名称须为 1–128 个字符，且不能换行。');
    if (!Array.isArray(rule.domains) || !rule.domains.length || rule.domains.length > 50) throw new TypeError('每条规则须填写 1–50 个域名。');
    const domains = [...new Set(rule.domains.map(normalizeWebsite))];
    for (const domain of domains) {
      if (hosts.has(domain)) throw new TypeError(`域名 ${domain} 已用于“${hosts.get(domain)}”，请在该规则中编辑。`);
      hosts.set(domain, name);
    }
    const ignoredNames = normalizeIgnoredNames(rule.ignoredNames);
    if (!ignoredNames.length) throw new TypeError('请至少填写一个忽略词；不再使用的规则可点击删除。');
    return { name, domains, ignoredNames };
  });
}
