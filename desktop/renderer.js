import { analyzeTabs } from './core.js';

const $ = (id) => document.getElementById(id);
let sources = [];
let groups = [];
const overrides = new Map();

function notice(text, error = false) {
  $('notice').textContent = text;
  $('notice').classList.toggle('error', error);
}

function updateCount() {
  const count = groups.flatMap((group) => group.tabs).filter((tab) => tab.selected).length;
  $('selected-count').textContent = count;
  $('export-count').textContent = count;
  $('export').disabled = count === 0;
}

function render() {
  const tabs = sources.flatMap((source) => source.tabs);
  groups = analyzeTabs(tabs, { sortBy: $('sort-by').value, direction: $('direction').value });
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
    for (const tab of group.tabs) {
      if (overrides.has(tab.id)) tab.selected = overrides.get(tab.id);
      const row = $('tab-template').content.firstElementChild.cloneNode(true);
      const checkbox = row.querySelector('input');
      checkbox.checked = tab.selected;
      checkbox.setAttribute('aria-label', `选择 ${tab.title || '无标题'}`);
      checkbox.addEventListener('change', () => { tab.selected = checkbox.checked; overrides.set(tab.id, tab.selected); updateCount(); });
      row.querySelector('.tab-title').textContent = tab.title || '无标题';
      row.querySelector('.tab-url').textContent = tab.url || '暂无网址';
      row.querySelector('.browser-label').textContent = tab.browser;
      row.querySelector('.tab-time').textContent = tab.openedAt == null ? '打开时间未知' : new Date(tab.openedAt).toLocaleString();
      card.querySelector('.group-tabs').append(row);
    }
    $('groups').append(card);
  });
  $('empty').hidden = groups.length > 0;
  $('empty').querySelector('h2').textContent = sources.length ? '暂未找到需要一起检查的标签页' : '让散落的标签页，重新有序';
  $('empty').querySelector('p').textContent = sources.length ? '新的标签页同步后，会自动重新检查。' : '连接 Chrome 或 Edge 后，相似标题会自动归组。';
  $('sort-note').textContent = $('sort-by').value === 'time'
    ? '浏览器无法提供可靠的原始打开时间。未知时间排在末尾，该组不自动预选。'
    : '每组首项建议保留，其余自动预选；你可以随时调整。更换排序会重新预选。';
  updateCount();
}

for (const id of ['sort-by', 'direction']) $(id).addEventListener('change', () => {
  overrides.clear(); render(); notice('已按新排序重新预选，请检查候选项。');
});
$('copy-code').addEventListener('click', async () => {
  try { await window.tabTidy.copyCode(); notice('连接码已复制，请粘贴到浏览器扩展中。'); } catch (error) { notice(error.message, true); }
});
$('open-extension').addEventListener('click', async () => {
  try { await window.tabTidy.openExtensionFolder(); } catch (error) { notice(error.message, true); }
});
$('show-setup').addEventListener('click', () => { $('setup').open = true; $('open-extension').focus(); });
$('export').addEventListener('click', async () => {
  try {
    const selected = groups.flatMap((group) => group.tabs).filter((tab) => tab.selected);
    if (await window.tabTidy.exportTabs(selected)) notice(`已导出 ${selected.length} 个已选标签页。浏览器中的标签页保持原样。`);
  } catch (error) { notice(`导出失败：${error.message}`, true); }
});
window.tabTidy.onSources((next) => { sources = next; render(); notice('标签页已同步。手动勾选已保留。'); });
try {
  const state = await window.tabTidy.getState();
  $('connection-code').value = state.token;
  sources = state.sources;
  render();
} catch (error) { notice(`初始化失败：${error.message}`, true); }
