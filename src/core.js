import { normalizeIgnoredNamesByHost } from './title-rules.js';

const naturalOrder = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

function titleKey(title, ignoredNames) {
  let normalized = title.normalize('NFKC').toLowerCase();
  if (ignoredNames) {
    let previous;
    do { previous = normalized; normalized = normalized.replace(ignoredNames, ''); } while (normalized !== previous);
  }
  const chapter = /第[\d〇零一二三四五六七八九十百千万两]+[章节回卷集部]/u.exec(normalized);
  const prefix = chapter && chapter.index > 0 ? normalized.slice(0, chapter.index) : normalized;
  const compact = prefix.replace(/[\p{P}\p{Z}\p{S}\s]/gu, '');
  return compact.replace(/\d+|(?:整理|更新|完整|精校|修订)版/gu, '') || compact;
}

function bigrams(text) {
  const characters = [...text];
  return new Set(characters.slice(1).map((character, index) => characters[index] + character));
}

function similarTitles(a, b, gramsA, gramsB) {
  if (!a || !b) return false;
  if (a === b) return true;
  const charactersA = [...a];
  const charactersB = [...b];
  if (Math.min(charactersA.length, charactersB.length) < 4) return false;
  let common = 0;
  for (const gram of gramsA) if (gramsB.has(gram)) common++;
  if ((2 * common) / (gramsA.size + gramsB.size) >= 0.8) return true;

  const shorter = charactersA.length <= charactersB.length ? charactersA : charactersB;
  const longer = shorter === charactersA ? b : a;
  const minimum = Math.max(4, Math.ceil(Math.max(charactersA.length, charactersB.length) / 2));
  // shortcut: 未配置的站点公共文字仍可能误匹配，出现误报时补充该站点的忽略名称。
  for (let index = 0; index <= shorter.length - minimum; index++) {
    if (longer.includes(shorter.slice(index, index + minimum).join(''))) return true;
  }
  return false;
}

export function analyzeTabs(tabs, options = {}) {
  if (!Array.isArray(tabs)) throw new TypeError('tabs must be an array');
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }
  const { sortBy = 'natural', direction = 'desc', ignoredNamesByHost = {} } = options;
  if (!['natural', 'time'].includes(sortBy)) throw new TypeError('sortBy must be natural or time');
  if (!['asc', 'desc'].includes(direction)) throw new TypeError('direction must be asc or desc');
  const rules = normalizeIgnoredNamesByHost(ignoredNamesByHost);
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const separator = '[\\p{P}\\p{Z}\\p{S}\\s]';
  const ignoredPatterns = new Map(Object.entries(rules).map(([host, names]) => {
    const words = names.map((name) => name.toLowerCase()).sort((a, b) => b.length - a.length).map(escape).join('|');
    const edges = `^${separator}*(?:${words})(?=$|${separator})|(?<![\\p{L}\\p{N}])(?:${words})${separator}*$`;
    const labels = [['[', ']'], ['(', ')'], ['【', '】'], ['「', '」'], ['『', '』']]
      .map(([left, right]) => `${escape(left)}\\s*(?:${words})\\s*${escape(right)}`).join('|');
    return [host, new RegExp(`${edges}|${labels}`, 'gu')];
  }));
  const ids = new Set();
  for (const tab of tabs) {
    if (!tab || typeof tab !== 'object' || Array.isArray(tab)) throw new TypeError('each tab must be an object');
    if (!(typeof tab.id === 'string' && tab.id.trim()) && !(Number.isSafeInteger(tab.id) && tab.id >= 0)) {
      throw new TypeError('tab.id must be a nonempty string or nonnegative safe integer');
    }
    if (ids.has(tab.id)) throw new TypeError(`duplicate id: ${tab.id}`);
    ids.add(tab.id);
    if (typeof tab.title !== 'string') throw new TypeError('tab.title must be a string');
    if (tab.url != null && (typeof tab.url !== 'string' || (tab.url && !URL.canParse(tab.url)))) {
      throw new TypeError('tab.url must be an absolute URL string or empty');
    }
    if (tab.openedAt != null && (!Number.isSafeInteger(tab.openedAt) || tab.openedAt < 0)) {
      throw new TypeError('tab.openedAt must be a nonnegative integer timestamp in milliseconds');
    }
  }
  const order = direction === 'asc' ? 1 : -1;
  const keys = tabs.map((tab) => {
    const url = tab.url && new URL(tab.url);
    const pattern = url && ['http:', 'https:'].includes(url.protocol) ? ignoredPatterns.get(url.hostname.replace(/\.$/, '')) : undefined;
    return titleKey(tab.title, pattern);
  });
  const grams = keys.map(bigrams);
  const parents = tabs.map((_, index) => index);
  const reasons = tabs.map(() => new Set());
  function root(index) {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  }

  for (let i = 0; i < tabs.length; i++) {
    for (let j = i + 1; j < tabs.length; j++) {
      const duplicateUrl = Boolean(tabs[i].url && tabs[i].url === tabs[j].url);
      const similarTitle = similarTitles(keys[i], keys[j], grams[i], grams[j]);
      if (!duplicateUrl && !similarTitle) continue;
      const a = root(i);
      const b = root(j);
      parents[b] = a;
      for (const reason of reasons[b]) reasons[a].add(reason);
      if (duplicateUrl) reasons[a].add('duplicate-url');
      if (similarTitle) reasons[a].add('similar-title');
    }
  }

  const groups = new Map();
  tabs.forEach((tab, index) => {
    const key = root(index);
    if (!groups.has(key)) groups.set(key, { reasons: [...reasons[key]].sort(), tabs: [] });
    groups.get(key).tabs.push(tab);
  });

  return [...groups.values()].filter((group) => group.tabs.length > 1).map((group) => {
    const canPreselect = sortBy !== 'time' || (group.tabs.every((tab) => tab.openedAt != null)
      && new Set(group.tabs.map((tab) => tab.openedAt)).size === group.tabs.length);
    const sorted = group.tabs.toSorted((a, b) => {
      if (sortBy === 'time') {
        if (a.openedAt == null) return b.openedAt == null ? 0 : 1;
        if (b.openedAt == null) return -1;
        return order * (a.openedAt - b.openedAt);
      }
      return order * naturalOrder.compare(a.title.normalize('NFKC'), b.title.normalize('NFKC'));
    });
    return {
      reasons: group.reasons,
      tabs: sorted.map((tab, index) => ({ ...tab, selected: canPreselect && index > 0 })),
    };
  });
}
