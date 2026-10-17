import { analyzeTabs } from './core.js';
import { normalizeWebsite } from './title-rules.js';

const $ = (id) => document.getElementById(id);
let sources = [];
let groups = [];
const overrides = new Map();
let closing = false;
let hasCloseResult = false;
let ignoreRules = [];
let savingRules = false;
let initialized = false;

function notice(text, error = false) {
  $('notice').textContent = text;
  $('notice').classList.toggle('error', error);
}

function updateCount() {
  const count = groups.flatMap((group) => group.tabs).filter((tab) => tab.selected).length;
  $('selected-count').textContent = count;
  $('close-count').textContent = count;
  const busy = !initialized || closing || savingRules;
  $('close-tabs').disabled = busy || count === 0;
  for (const input of document.querySelectorAll('.tab-row input, .group-checkbox, #sort-by, #direction, #ignore-form input, #ignore-form textarea, #ignore-form button, #ignore-form select')) input.disabled = busy;
  $('delete-ignore').disabled = busy || $('ignore-rule').value === '-1';
}

function updateWebsiteChoices(tabs) {
  const hosts = new Set(ignoreRules.flatMap((rule) => rule.domains));
  for (const tab of tabs) {
    if (!tab.url) continue;
    const url = new URL(tab.url);
    if (['http:', 'https:'].includes(url.protocol)) {
      try { hosts.add(normalizeWebsite(url.hostname)); } catch { /* 非网站域名不提供设置。 */ }
    }
  }
  const values = [...hosts].sort();
  const list = $('website-hosts');
  if (JSON.stringify(values) === JSON.stringify(Array.from(list.options).slice(1).map((option) => option.value))) return;
  list.replaceChildren(list.options[0], ...values.map((host) => { const option = document.createElement('option'); option.value = host; option.textContent = host; return option; }));
}

function editRule(index) {
  const rule = ignoreRules[index];
  $('ignore-rule').value = String(index);
  $('ignore-name').value = rule?.name || '';
  $('ignore-domains').value = rule?.domains.join('\n') || '';
  $('ignore-words').value = rule?.ignoredNames.join('\n') || '';
  updateCount();
}

function updateRuleChoices(index = -1) {
  const options = ignoreRules.map((rule, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `${rule.name}（${rule.domains[0]}${rule.domains.length > 1 ? ` 等 ${rule.domains.length} 个域名` : ''}）`;
    return option;
  });
  $('ignore-rule').replaceChildren($('ignore-rule').options[0], ...options);
  editRule(index);
}

function render() {
  const focusedId = document.activeElement?.dataset.tabId;
  const focusedGroupId = document.activeElement?.dataset.groupId;
  const scrollPosition = window.scrollY;
  let focusTarget;
  const tabs = sources.flatMap((source) => source.tabs);
  const ignoredNamesByHost = Object.fromEntries(ignoreRules.flatMap((rule) => rule.domains.map((host) => [host, rule.ignoredNames])));
  groups = analyzeTabs(tabs, { sortBy: $('sort-by').value, direction: $('direction').value, ignoredNamesByHost });
  updateWebsiteChoices(tabs);
  const activeIds = new Set(tabs.map((tab) => tab.id));
  for (const id of overrides.keys()) if (!activeIds.has(id)) overrides.delete(id);
  $('tab-count').textContent = tabs.length;
  $('group-count').textContent = groups.length;
  $('sources').replaceChildren();
  for (const source of sources) {
    const item = document.createElement('div');
    item.className = 'source';
    const title = document.createElement('strong');
    title.textContent = `${source.browser} · ${source.tabs.length} 个标签页`;
    const time = document.createElement('small');
    time.textContent = `已同步 ${new Date(source.receivedAt).toLocaleTimeString()} · ${source.sourceId.slice(0, 6)}`;
    item.append(title, time);
    $('sources').append(item);
  }
  if (!sources.length) $('sources').textContent = '等待浏览器同步';
  $('groups').replaceChildren();
  groups.forEach((group, index) => {
    const card = $('group-template').content.firstElementChild.cloneNode(true);
    card.querySelector('.group-index').textContent = String(index + 1).padStart(2, '0');
    card.querySelector('.group-title').textContent = group.tabs[0].title || '无标题';
    card.querySelector('.group-size').textContent = `${group.tabs.length} 项`;
    card.querySelector('.group-reason').textContent = group.reasons.map((reason) => reason === 'duplicate-url' ? '网址重复' : '标题相似').join(' · ');
    const groupCheckbox = card.querySelector('.group-checkbox');
    groupCheckbox.dataset.groupId = group.tabs[0].id;
    groupCheckbox.setAttribute('aria-label', `全选本组：第 ${index + 1} 组，${group.tabs[0].title || '无标题'}`);
    if (group.tabs.some((tab) => tab.id === focusedGroupId)) focusTarget = groupCheckbox;
    const updateGroupSelection = () => {
      const selected = group.tabs.filter((tab) => tab.selected).length;
      groupCheckbox.checked = selected === group.tabs.length;
      groupCheckbox.indeterminate = selected > 0 && selected < group.tabs.length;
    };
    groupCheckbox.addEventListener('change', () => {
      const selected = groupCheckbox.checked;
      for (const tab of group.tabs) { tab.selected = selected; overrides.set(tab.id, selected); }
      for (const checkbox of card.querySelectorAll('.tab-row input')) checkbox.checked = selected;
      updateGroupSelection();
      updateCount();
    });
    for (const tab of group.tabs) {
      if (overrides.has(tab.id)) tab.selected = overrides.get(tab.id);
      const row = $('tab-template').content.firstElementChild.cloneNode(true);
      const checkbox = row.querySelector('input');
      checkbox.dataset.tabId = tab.id;
      if (tab.id === focusedId) focusTarget = checkbox;
      checkbox.checked = tab.selected;
      checkbox.setAttribute('aria-label', `选择 ${tab.title || '无标题'}`);
      checkbox.addEventListener('change', () => {
        tab.selected = checkbox.checked; overrides.set(tab.id, tab.selected);
        updateGroupSelection(); updateCount();
      });
      row.querySelector('.tab-title').textContent = tab.title || '无标题';
      row.querySelector('.tab-url').textContent = tab.url || '暂无网址';
      row.querySelector('.browser-label').textContent = tab.browser;
      row.querySelector('.tab-time').textContent = tab.openedAt == null ? '打开时间未知' : new Date(tab.openedAt).toLocaleString();
      card.querySelector('.group-tabs').append(row);
    }
    updateGroupSelection();
    $('groups').append(card);
  });
  $('empty').hidden = groups.length > 0;
  $('empty').querySelector('h2').textContent = sources.length ? '暂未找到需要一起检查的标签页' : '让散落的标签页，重新有序';
  $('empty').querySelector('p').textContent = sources.length ? '新的标签页同步后，会自动重新检查。' : '连接 Chrome 或 Edge 后，相似标题会自动归组。';
  $('sort-note').textContent = $('sort-by').value === 'time'
    ? '浏览器无法提供可靠的原始打开时间。未知时间排在末尾，该组不自动预选。'
    : '每组首项建议保留，其余自动预选；你可以随时调整。更换排序会重新预选。';
  updateCount();
  window.scrollTo(0, scrollPosition);
  focusTarget?.focus({ preventScroll: true });
}

for (const id of ['sort-by', 'direction']) $(id).addEventListener('change', () => {
  overrides.clear(); render(); notice('已按新排序重新预选，请检查候选项。');
});
$('ignore-rule').addEventListener('change', () => editRule(Number($('ignore-rule').value)));
const lines = (id) => $(id).value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
$('website-hosts').addEventListener('change', () => {
  const host = $('website-hosts').value;
  if (!host) return;
  const domains = lines('ignore-domains');
  if (!domains.some((domain) => { try { return normalizeWebsite(domain) === host; } catch { return false; } })) domains.push(host);
  $('ignore-domains').value = domains.join('\n');
  $('website-hosts').value = '';
});

async function persistRules(next, index, message) {
  if (!initialized || closing || savingRules) return;
  const focusedElement = document.activeElement;
  savingRules = true;
  updateCount();
  try {
    const result = await window.tabTidy.saveIgnoredNames(next);
    if (!result.ok) throw new Error(result.error);
    ignoreRules = result.rules;
    updateRuleChoices(index);
    overrides.clear(); hasCloseResult = false; render();
    notice(`${message}，已重新分组和预选，请核对候选项。`);
  } catch (error) { notice(`设置保存失败：${error.message}`, true); }
  finally {
    savingRules = false; updateCount();
    if (document.activeElement === document.body) focusedElement?.focus({ preventScroll: true });
  }
}
$('ignore-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const next = [...ignoreRules];
  const index = $('ignore-rule').value === '-1' ? next.length : Number($('ignore-rule').value);
  next[index] = { name: $('ignore-name').value, domains: lines('ignore-domains'), ignoredNames: lines('ignore-words') };
  void persistRules(next, index, '忽略规则已保存并自动应用');
});
$('delete-ignore').addEventListener('click', () => {
  const index = Number($('ignore-rule').value);
  if (index < 0) return;
  void persistRules(ignoreRules.filter((_rule, position) => position !== index), -1, '忽略规则已删除');
});
$('copy-code').addEventListener('click', async () => {
  try { await window.tabTidy.copyCode(); notice('连接码已复制，请粘贴到浏览器扩展中。'); } catch (error) { notice(error.message, true); }
});
$('open-extension').addEventListener('click', async () => {
  try { await window.tabTidy.openExtensionFolder(); } catch (error) { notice(error.message, true); }
});
$('show-setup').addEventListener('click', () => { $('setup').open = true; $('open-extension').focus(); });
$('close-tabs').addEventListener('click', async () => {
  if (closing) return;
  const selected = groups.flatMap((group) => group.tabs).filter((tab) => tab.selected);
  if (!selected.length) return;
  closing = true;
  hasCloseResult = false;
  updateCount();
  notice('请确认待关闭的标签页，确认后将由浏览器执行关闭。');
  try {
    const result = await window.tabTidy.closeTabs(selected);
    if (result.canceled) { notice('已取消关闭。'); return; }
    const counts = new Map(['closed', 'skipped', 'failed', 'unknown'].map((status) => [status, result.results.filter((item) => item.status === status).length]));
    const issues = result.results.filter((item) => item.status !== 'closed');
    let text = `已关闭 ${counts.get('closed')} 个标签页；跳过 ${counts.get('skipped')} 个，失败 ${counts.get('failed')} 个，结果未知 ${counts.get('unknown')} 个。`;
    if (issues.length) text += ` ${issues.slice(0, 5).map((item) => `${selected.find((tab) => tab.id === item.id)?.title || '无标题'}：${item.error || '请检查浏览器实际状态。'}`).join('；')}${issues.length > 5 ? '；其余请查看浏览器实际状态。' : ''}`;
    notice(text, issues.length > 0);
  } catch (error) { notice(`关闭未完成：${error.message} 请检查浏览器实际状态后再操作。`, true); }
  finally { closing = false; hasCloseResult = true; updateCount(); }
});
window.tabTidy.onSources((next) => { sources = next; render(); if (!closing && !hasCloseResult) notice('标签页已同步。手动勾选已保留。'); });
try {
  const state = await window.tabTidy.getState();
  ignoreRules = state.ignoreRules;
  initialized = true;
  updateRuleChoices();
  $('connection-code').value = state.token;
  sources = state.sources;
  render();
} catch (error) { notice(`初始化失败：${error.message}`, true); }
