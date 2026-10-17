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
let editingRule = null;
let autoPreselect = true;

function notice(text, error = false, id = 'notice') {
  $(id).textContent = text;
  $(id).classList.toggle('error', error);
}

function updateCount() {
  const count = groups.flatMap((group) => group.tabs).filter((tab) => tab.selected).length;
  $('selected-count').textContent = count;
  $('close-count').textContent = count;
  const busy = !initialized || closing || savingRules;
  $('close-tabs').disabled = busy || count === 0;
  for (const input of document.querySelectorAll('.tab-row input, .group-checkbox, #sort-by, #direction, #auto-preselect, #open-settings, #ignore-nav, #add-rule, .rule-card button, #ignore-form input, #ignore-form textarea, #ignore-form button, #ignore-form select')) input.disabled = busy;
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
  $('rule-count').textContent = `已保存 ${ignoreRules.length} 条规则`;
  $('rules-empty').hidden = ignoreRules.length > 0;
  $('rule-cards').replaceChildren(...ignoreRules.map((rule, index) => {
    const card = document.createElement('article');
    card.className = 'rule-card';
    const header = document.createElement('div');
    header.className = 'rule-card-header';
    const heading = document.createElement('div');
    const title = document.createElement('h4');
    title.textContent = rule.name;
    const count = document.createElement('p');
    count.className = 'rule-card-count';
    count.textContent = `${rule.domains.length} 个域名 · ${rule.ignoredNames.length} 个忽略词`;
    heading.append(title, count);
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
      tab.selected = overrides.has(tab.id) ? overrides.get(tab.id) : autoPreselect && tab.selected;
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
  $('auto-preselect').setAttribute('aria-checked', String(autoPreselect));
  $('auto-preselect-state').textContent = autoPreselect ? '开' : '关';
  $('sort-note').textContent = !autoPreselect
    ? '自动预选已关闭；新增项不自动勾选，手动选择在同步与排序后保留。'
    : $('sort-by').value === 'time'
    ? '浏览器无法提供可靠的原始打开时间。未知时间排在末尾，该组不自动预选。'
    : '每组首项建议保留，其余自动预选；你可以随时调整。更换排序会重新预选。';
  updateCount();
  window.scrollTo(0, scrollPosition);
  focusTarget?.focus({ preventScroll: true });
}

for (const id of ['sort-by', 'direction']) $(id).addEventListener('change', () => {
  if (autoPreselect) overrides.clear();
  render();
  notice(autoPreselect ? '已按新排序重新预选，请检查候选项。' : '已调整排序，自动预选保持关闭，手动勾选已保留。');
});
$('auto-preselect').addEventListener('click', () => {
  if (!initialized || closing || savingRules) return;
  autoPreselect = !autoPreselect;
  let stored = true;
  try { localStorage.setItem('auto-preselect', String(autoPreselect)); } catch { stored = false; }
  render();
  const message = autoPreselect
    ? '已开启自动预选，按当前排序处理；手动勾选和取消已保留，请核对候选项。'
    : '已关闭自动预选，已取消自动勾选；手动勾选已保留。';
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
    hasCloseResult = false; render();
    const text = autoPreselect ? `${message}，已重新分组和预选，请核对候选项。`
      : `${message}，已重新分组；自动预选保持关闭，手动勾选已保留。`;
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
  void persistRules(next, index, '忽略规则已保存并自动应用');
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
  try { autoPreselect = localStorage.getItem('auto-preselect') !== 'false'; }
  catch { autoPreselect = false; notice('无法读取自动预选偏好，本次已关闭自动预选；仍可手动勾选或开启。', true); }
  initialized = true;
  renderRuleCards();
  $('connection-code').value = state.token;
  sources = state.sources;
  render();
} catch (error) { notice(`初始化失败：${error.message}`, true); }
