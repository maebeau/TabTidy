import { analyzeTabs } from './core.js';
import { normalizeWebsite } from './title-rules.js';

const $ = (id) => document.getElementById(id);
let sources = [];
let groups = [];
const overrides = new Map();
let closing = false;
let locating = false;
let ignoreRules = [];
let savingRules = false;
let initialized = false;
let editingRule = null;
let autoPreselect = true;
let groupRange = { min: 2, max: Infinity };

function updateBackToTop() {
  $('back-to-top').hidden = window.scrollY <= 300;
}
window.addEventListener('scroll', updateBackToTop, { passive: true });
window.addEventListener('resize', updateBackToTop);
$('back-to-top').addEventListener('click', () => {
  $('page-title').focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
});

function notice(text, error = false, id = 'notice') {
  $(id).textContent = text;
  $(id).classList.toggle('error', error);
}

function updateCount() {
  const count = groups.flatMap((group) => group.tabs).filter((tab) => tab.selected).length;
  $('selected-count').textContent = count;
  const busy = !initialized || closing || savingRules || locating;
  $('close-tabs').disabled = busy || count === 0;
  for (const input of document.querySelectorAll('.tab-row input, .locate-tab, #tab-search, #only-selected, .group-checkbox, #sort-by, #direction, #auto-preselect, #group-filter input, #group-filter button, #open-settings, #ignore-nav, #add-rule, .rule-card button, #ignore-form input, #ignore-form textarea, #ignore-form button, #ignore-form select')) input.disabled = busy;
  $('source-filter').disabled = busy || sources.length === 0;
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
  editingRule = index;
  const rule = ignoreRules[index];
  $('ignore-name').value = rule?.name || '';
  $('ignore-domains').value = rule?.domains.join('\n') || '';
  $('ignore-words').value = rule?.ignoredNames.join('\n') || '';
  $('website-hosts').value = '';
  $('rule-editor-title').textContent = rule ? '编辑规则' : '添加规则';
  $('rule-editor').hidden = false;
  $('rule-list').hidden = true;
  $('add-rule').hidden = true;
  notice('', false, 'settings-notice');
  updateCount();
  $('ignore-name').focus();
  document.querySelector('.settings-content').scrollTop = 0;
}

function showRuleList() {
  editingRule = null;
  $('rule-editor').hidden = true;
  $('rule-list').hidden = false;
  $('add-rule').hidden = false;
  $('ignore-form').reset();
}

function renderRuleCards() {
  $('rule-count').textContent = `${ignoreRules.length} 条`;
  $('rules-empty').hidden = ignoreRules.length > 0;
  $('rule-cards').replaceChildren(...ignoreRules.map((rule, index) => {
    const card = document.createElement('article');
    card.className = 'rule-card';
    const header = document.createElement('div');
    header.className = 'rule-card-header';
    const heading = document.createElement('div');
    const title = document.createElement('h4');
    title.textContent = rule.name;
    heading.append(title);
    const actions = document.createElement('div');
    actions.className = 'rule-card-actions';
    for (const [action, label] of [['edit', '编辑'], ['delete', '删除']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `${action}-rule secondary`;
      button.dataset.ruleIndex = String(index);
      button.textContent = label;
      button.setAttribute('aria-label', `${label}规则：${rule.name}`);
      button.addEventListener('click', () => {
        if (action === 'edit') editRule(index);
        else void persistRules(ignoreRules.filter((_rule, position) => position !== index), index, '忽略规则已删除');
      });
      actions.append(button);
    }
    header.append(heading, actions);
    card.append(header);
    for (const [label, values, className] of [['域名', rule.domains, 'rule-domains'], ['忽略词', rule.ignoredNames, 'rule-words']]) {
      const row = document.createElement('div');
      row.className = `rule-card-row ${className}`;
      const key = document.createElement('span');
      key.className = 'rule-card-label';
      key.textContent = label;
      const chips = document.createElement('div');
      chips.className = 'rule-chips';
      for (const value of values) {
        const chip = document.createElement('span');
        chip.textContent = value;
        chips.append(chip);
      }
      row.append(key, chips);
      card.append(row);
    }
    return card;
  }));
  updateCount();
}

function sourceLabel(source) {
  return sources.filter((item) => item.browser === source.browser).length > 1 ? `${source.browser} · ${source.sourceId.slice(0, 6)}` : source.browser;
}

function renderSources() {
  const filter = $('source-filter');
  if (filter.options.length !== sources.length + 1 || sources.some((source, index) => filter.options[index + 1]?.value !== source.sourceId || filter.options[index + 1]?.textContent !== sourceLabel(source))) {
    const selected = filter.value;
    filter.replaceChildren(filter.options[0], ...sources.map((source) => {
      const option = document.createElement('option');
      option.value = source.sourceId;
      option.textContent = sourceLabel(source);
      return option;
    }));
    filter.value = sources.some((source) => source.sourceId === selected) ? selected : '';
  }
  $('sources').replaceChildren();
  for (const source of sources) {
    const item = document.createElement('div');
    item.className = 'source';
    item.dataset.browser = source.browser;
    item.title = `${source.tabs.length} 个标签页 · 来源 ${source.sourceId} · 上次同步 ${new Date(source.receivedAt).toLocaleTimeString()}`;
    const heading = document.createElement('div');
    heading.className = 'source-heading';
    const title = document.createElement('strong');
    title.textContent = sourceLabel(source);
    const count = document.createElement('span');
    count.textContent = source.tabs.length;
    heading.append(title, count);
    const status = document.createElement('small');
    status.className = 'source-state';
    status.textContent = !source.sessionId ? '扩展需升级' : source.connected ? '已连接' : '等待重连 · 旧列表';
    status.dataset.connected = String(source.connected);
    item.append(heading, status);
    $('sources').append(item);
  }
  if (!sources.length) $('sources').textContent = '等待浏览器同步';
}

function render() {
  const focusedId = document.activeElement?.dataset.tabId;
  const focusedLocateId = document.activeElement?.dataset.focusTabId;
  const focusedGroupId = document.activeElement?.dataset.groupId;
  const focusedRowIndex = [...document.querySelectorAll('.tab-row input')].indexOf(document.activeElement);
  const scrollPosition = window.scrollY;
  let focusTarget;
  renderSources();
  const allTabs = sources.flatMap((source) => source.tabs);
  const tabs = sources.filter((source) => !$('source-filter').value || source.sourceId === $('source-filter').value).flatMap((source) => source.tabs);
  const mixedSources = new Set(tabs.map((tab) => tab.sourceId)).size > 1;
  const ignoredNamesByHost = Object.fromEntries(ignoreRules.flatMap((rule) => rule.domains.map((host) => [host, rule.ignoredNames])));
  const query = $('tab-search').value.trim().normalize('NFKC').toLocaleLowerCase();
  const selectedOnly = $('only-selected').checked;
  groups = analyzeTabs(tabs, { sortBy: $('sort-by').value, direction: $('direction').value, ignoredNamesByHost })
    .filter((group) => group.tabs.length >= groupRange.min && group.tabs.length <= groupRange.max)
    .map((group) => ({ ...group, total: group.tabs.length, title: group.tabs[0].title, tabs: group.tabs.map((tab) => ({ ...tab,
      selected: overrides.has(tab.id) ? overrides.get(tab.id) : autoPreselect && tab.selected,
    })).filter((tab) => (!selectedOnly || tab.selected) && (!query || `${tab.title}\n${tab.url}`.normalize('NFKC').toLocaleLowerCase().includes(query))) }))
    .filter((group) => group.tabs.length > 0);
  const rangeFiltering = groupRange.min > 2 || groupRange.max !== Infinity;
  const filtering = rangeFiltering || Boolean(query) || selectedOnly;
  updateWebsiteChoices(allTabs);
  const activeIds = new Set(allTabs.map((tab) => tab.id));
  for (const id of overrides.keys()) if (!activeIds.has(id)) overrides.delete(id);
  $('tab-count').textContent = filtering ? groups.reduce((count, group) => count + group.tabs.length, 0) : tabs.length;
  $('tab-count-label').textContent = filtering ? '筛选内标签页' : '标签页';
  $('group-count').textContent = groups.length;
  $('groups').replaceChildren();
  groups.forEach((group, index) => {
    const card = $('group-template').content.firstElementChild.cloneNode(true);
    card.querySelector('.group-title').textContent = group.title || '无标题';
    card.querySelector('.group-title').title = group.title || '无标题';
    card.querySelector('.group-size').textContent = group.total === group.tabs.length ? `${group.total} 项` : `${group.tabs.length} / ${group.total} 项`;
    card.querySelector('.group-header').title = group.reasons.map((reason) => reason === 'duplicate-url' ? '网址重复' : '标题相似').join(' · ');
    const groupCheckbox = card.querySelector('.group-checkbox');
    groupCheckbox.dataset.groupId = group.tabs[0].id;
    groupCheckbox.setAttribute('aria-label', `${group.total === group.tabs.length ? '全选本组' : '全选显示项'}：第 ${index + 1} 组，${group.title || '无标题'}`);
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
      if (selectedOnly) render();
    });
    for (const tab of group.tabs) {
      const row = $('tab-template').content.firstElementChild.cloneNode(true);
      const checkbox = row.querySelector('input');
      checkbox.dataset.tabId = tab.id;
      if (tab.id === focusedId) focusTarget = checkbox;
      checkbox.checked = tab.selected;
      checkbox.setAttribute('aria-label', `选择 ${tab.title || '无标题'}`);
      checkbox.addEventListener('change', () => {
        tab.selected = checkbox.checked; overrides.set(tab.id, tab.selected);
        updateGroupSelection(); updateCount();
        if (selectedOnly) render();
      });
      row.querySelector('.tab-title').textContent = tab.title || '无标题';
      row.querySelector('.tab-url').textContent = tab.url || '暂无网址';
      row.querySelector('.browser-label').textContent = sourceLabel(tab);
      row.querySelector('.browser-label').hidden = !mixedSources;
      row.querySelector('.tab-time').textContent = tab.openedAt == null ? '' : new Date(tab.openedAt).toLocaleString();
      row.querySelector('.tab-time').hidden = tab.openedAt == null;
      row.querySelector('.tab-meta').hidden = !mixedSources && tab.openedAt == null;
      const locate = row.querySelector('.locate-tab');
      locate.dataset.focusTabId = tab.id;
      locate.setAttribute('aria-label', `定位 ${tab.title || '无标题'}`);
      if (tab.id === focusedLocateId) focusTarget = locate;
      locate.addEventListener('click', async () => {
        if (closing || locating || savingRules) return;
        locating = true; updateCount(); notice('正在定位标签页…');
        try {
          const result = await window.tabTidy.focusTab(tab);
          notice(result.status === 'focused' ? '已定位原标签页。' : `定位未完成：${result.error || '请检查浏览器实际状态。'}`, result.status !== 'focused');
        } catch (error) { notice(`定位未完成：${error.message}`, true); }
        finally {
          locating = false; updateCount();
          [...document.querySelectorAll('.locate-tab')].find((button) => button.dataset.focusTabId === tab.id)?.focus({ preventScroll: true });
        }
      });
      card.querySelector('.group-tabs').append(row);
    }
    updateGroupSelection();
    $('groups').append(card);
  });
  $('empty').hidden = groups.length > 0;
  $('empty').querySelector('h2').textContent = !sources.length ? '等待浏览器连接' : query || selectedOnly ? '没有符合条件的标签页' : rangeFiltering ? '没有符合项数条件的分组' : '暂无相似分组';
  $('empty').querySelector('p').textContent = !sources.length ? '首次配对后自动连接。' : query || selectedOnly ? '清除搜索、关闭只看已选，或调整每组项数。' : rangeFiltering ? '调整数量范围，或重置筛选。' : '新标签页会自动更新到这里。';
  $('show-setup').hidden = filtering && sources.length > 0;
  $('show-setup').textContent = sources.length ? '连接其他浏览器' : '连接浏览器';
  $('group-filter-note').textContent = !rangeFiltering ? '' : groupRange.max === Infinity ? `每组至少 ${groupRange.min} 项` : `每组 ${groupRange.min}–${groupRange.max} 项`;
  $('view-filter-note').textContent = query || selectedOnly ? '仅显示匹配项；关闭和整组勾选只作用于当前显示项。' : '';
  $('auto-preselect').setAttribute('aria-checked', String(autoPreselect));
  $('sort-note').className = $('sort-by').value === 'time' ? 'note' : 'sr-only';
  $('sort-note').textContent = $('sort-by').value === 'time' ? '打开时间未知，分组不自动预选。'
    : autoPreselect ? '按排序保留每组首项，预选其余项；切换排序会重新预选。' : '自动预选已关闭，手动勾选不受影响。';
  updateCount();
  window.scrollTo(0, scrollPosition);
  updateBackToTop();
  if (!focusTarget && (focusedId || focusedGroupId || focusedLocateId)) focusTarget = document.querySelectorAll('.tab-row input')[Math.max(0, focusedRowIndex)] || document.querySelector('.tab-row input') || $('only-selected');
  focusTarget?.focus({ preventScroll: true });
}

$('tab-search').addEventListener('input', (event) => { if (!event.isComposing) render(); });
$('tab-search').addEventListener('compositionend', () => render());
$('only-selected').addEventListener('change', () => render());

$('group-filter').addEventListener('submit', (event) => {
  event.preventDefault();
  const min = $('group-min').valueAsNumber;
  const max = $('group-max').value === '' ? Infinity : $('group-max').valueAsNumber;
  if (max < min) {
    $('group-max').setCustomValidity('最多项数不能小于最少项数。');
    $('group-max').reportValidity();
    return;
  }
  groupRange = { min, max };
  render();
  notice('');
});
for (const id of ['group-min', 'group-max']) $(id).addEventListener('input', () => $('group-max').setCustomValidity(''));
$('group-filter').addEventListener('reset', () => {
  groupRange = { min: 2, max: Infinity };
  $('group-max').setCustomValidity('');
  render();
  notice('已清除筛选。');
});
$('source-filter').addEventListener('change', () => {
  window.scrollTo(0, 0);
  render();
  notice('');
});
for (const id of ['sort-by', 'direction']) $(id).addEventListener('change', () => {
  if (autoPreselect) overrides.clear();
  render();
  notice(autoPreselect ? '已重新预选，请核对勾选项。' : '排序已更新，自动预选保持关闭。');
});
$('auto-preselect').addEventListener('click', () => {
  if (!initialized || closing || savingRules) return;
  autoPreselect = !autoPreselect;
  let stored = true;
  try { localStorage.setItem('auto-preselect', String(autoPreselect)); } catch { stored = false; }
  render();
  const message = autoPreselect
    ? '已开启自动预选。'
    : '已关闭自动预选。';
  notice(`${message}${stored ? '' : ' 开关偏好未能保存，重启后可能恢复默认。'}`, !stored);
});
$('open-settings').addEventListener('click', () => {
  if (!$('settings-dialog').open) $('settings-dialog').showModal();
});
$('close-settings').addEventListener('click', () => $('settings-dialog').close());
$('settings-dialog').addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  const controls = [...$('settings-dialog').querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')]
    .filter((control) => control.getClientRects().length > 0);
  const first = controls[0];
  const last = controls.at(-1);
  // Electron 在原生对话框末项之后会将焦点交给窗口层级。
  if (document.activeElement === (event.shiftKey ? first : last)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
});
$('ignore-nav').addEventListener('click', () => {
  document.querySelector('.settings-content').scrollTop = 0;
  $('ignore-title').focus({ preventScroll: true });
});
$('add-rule').addEventListener('click', () => editRule(-1));
$('cancel-rule').addEventListener('click', () => {
  const index = editingRule;
  showRuleList();
  notice('', false, 'settings-notice');
  ($('rule-cards').children[index]?.querySelector('.edit-rule') || $('add-rule')).focus();
});
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
  let saved = false;
  updateCount();
  notice('正在保存设置…', false, 'settings-notice');
  try {
    const result = await window.tabTidy.saveIgnoredNames(next);
    if (!result.ok) throw new Error(result.error);
    ignoreRules = result.rules;
    showRuleList();
    renderRuleCards();
    if (autoPreselect) overrides.clear();
    render();
    const text = autoPreselect ? `${message}，已重新预选。`
      : `${message}，自动预选保持关闭。`;
    notice(text);
    notice(text, false, 'settings-notice');
    saved = true;
  } catch (error) {
    notice(`设置保存失败：${error.message}`, true);
    notice(`设置保存失败：${error.message}`, true, 'settings-notice');
  }
  finally {
    savingRules = false; updateCount();
    if (saved && $('settings-dialog').open) ($('rule-cards').children[index]?.querySelector('.edit-rule') || $('add-rule')).focus({ preventScroll: true });
    else if (document.activeElement === document.body) focusedElement?.focus({ preventScroll: true });
  }
}
$('ignore-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (editingRule === null) return;
  const next = [...ignoreRules];
  const index = editingRule === -1 ? next.length : editingRule;
  next[index] = { name: $('ignore-name').value, domains: lines('ignore-domains'), ignoredNames: lines('ignore-words') };
  void persistRules(next, index, '忽略规则已保存');
});
$('copy-code').addEventListener('click', async () => {
  try { await window.tabTidy.copyCode(); notice('连接码已复制。'); } catch (error) { notice(error.message, true); }
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
  updateCount();
  notice('请在弹窗确认关闭。');
  try {
    const result = await window.tabTidy.closeTabs(selected);
    if (result.canceled) { notice('已取消关闭。'); return; }
    const counts = new Map(['closed', 'skipped', 'failed', 'unknown'].map((status) => [status, result.results.filter((item) => item.status === status).length]));
    const issues = result.results.filter((item) => item.status !== 'closed');
    let text = `已关闭 ${counts.get('closed')} 个标签页；跳过 ${counts.get('skipped')} 个，失败 ${counts.get('failed')} 个，结果未知 ${counts.get('unknown')} 个。`;
    if (issues.length) text += ` ${issues.slice(0, 5).map((item) => `${selected.find((tab) => tab.id === item.id)?.title || '无标题'}：${item.error || '请检查浏览器实际状态。'}`).join('；')}${issues.length > 5 ? '；其余请查看浏览器实际状态。' : ''}`;
    notice(text, issues.length > 0);
  } catch (error) { notice(`关闭未完成：${error.message} 请检查浏览器实际状态后再操作。`, true); }
  finally { closing = false; updateCount(); }
});
window.tabTidy.onSources((next) => {
  const changed = next.length !== sources.length || next.some((source, index) => source.sourceId !== sources[index]?.sourceId || source.revision !== sources[index]?.revision);
  if (!sources.length && next.length) {
    if ($('setup').contains(document.activeElement)) $('setup').querySelector('summary').focus({ preventScroll: true });
    $('setup').open = false;
  }
  sources = next;
  if (!changed) { renderSources(); return; }
  render();
});
try {
  const state = await window.tabTidy.getState();
  ignoreRules = state.ignoreRules;
  try { autoPreselect = localStorage.getItem('auto-preselect') !== 'false'; }
  catch { autoPreselect = false; notice('无法读取自动预选偏好，本次已关闭自动预选；仍可手动勾选或开启。', true); }
  initialized = true;
  renderRuleCards();
  $('connection-code').value = state.token;
  sources = state.sources;
  if (sources.length) $('setup').open = false;
  render();
} catch (error) { notice(`初始化失败：${error.message}`, true); }
