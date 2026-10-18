const assert = require('node:assert/strict');
const { app, BrowserWindow, dialog } = require('electron');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const temporary = mkdtempSync(join(tmpdir(), 'tabtidy-desktop-'));
app.setPath('userData', temporary);
const timeout = setTimeout(() => { console.error('桌面测试超时'); app.exit(1); }, 30000);

async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('桌面界面未达到预期状态');
}

(async () => {
  const legacyRule = { name: 'legacy.example', domains: ['legacy.example'], ignoredNames: ['旧网站名'] };
  const legacyFile = JSON.stringify({ 'legacy.example': ['旧网站名'] });
  writeFileSync(join(temporary, 'ignored-names.json'), legacyFile);
  const ready = new Promise((resolve) => app.once('browser-window-created', (_event, window) => {
    window.webContents.once('did-finish-load', () => resolve(window));
  }));
  await import('../desktop/main.js');
  const window = await ready;
  const js = (code) => window.webContents.executeJavaScript(code);
  const groupSelection = () => js(`Array.from(document.querySelectorAll('.group'), group => ({
    checked: group.querySelector('.group-checkbox').checked,
    indeterminate: group.querySelector('.group-checkbox').indeterminate,
    selected: group.querySelectorAll('.tab-row input:checked').length,
  }))`);
  await waitFor(() => js("Boolean(document.getElementById('connection-code').value)"));
  assert.equal(await js("document.getElementById('back-to-top').hidden"), true, '顶部默认隐藏回到顶部按钮');
  assert.equal(await js("document.getElementById('source-filter').disabled"), true, '尚无来源时禁用来源选择');
  const token = await js('window.tabTidy.getState().then(state => state.token)');
  assert.equal(await js("document.getElementById('settings-dialog').open"), false, '设置默认关闭');
  assert.equal(await js("document.querySelector('main #ignore-settings')"), null, '主列表不再包含忽略规则表单');
  assert.equal(await js("document.getElementById('ignore-form').closest('dialog').id"), 'settings-dialog');
  assert.equal(await js("document.getElementById('open-settings').getAttribute('aria-label')"), '设置');
  assert.equal(await js("document.getElementById('open-settings').textContent.trim()"), '', '设置入口使用图标');
  assert.equal(await js("document.querySelectorAll('#open-settings svg').length"), 1);
  assert.equal(await js("document.querySelectorAll('.rule-card').length"), 1, '旧规则应显示为卡片');
  assert.equal(await js("document.querySelector('.rule-card h4').textContent"), 'legacy.example');
  assert.equal(await js("document.getElementById('rule-editor').hidden"), true, '默认展示卡片列表');
  assert.deepEqual(await js('window.tabTidy.getState().then(state => state.ignoreRules)'), [legacyRule]);
  assert.equal(await readFile(join(temporary, 'ignored-names.json'), 'utf8'), legacyFile, '自动迁移不能在读取时改写旧文件');
  const post = async (sourceId, browser, tabs, canFocus = true) => {
    const response = await fetch('http://127.0.0.1:37843/tabs', { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: `chrome-extension://${'a'.repeat(32)}` },
      body: JSON.stringify({ sourceId, sessionId: `${sourceId}-session`, browser, canFocus, tabs }),
    });
    assert.equal(response.status, 200);
  };
  const longTabs = Array.from({ length: 40 }, (_, index) => ({ id: index + 100,
    title: `回到顶部测试 第${index + 1}章`, url: `https://example.com/scroll/${index + 1}` }));
  await js("document.getElementById('connection-code').focus()");
  await post('chrome-test', 'Chrome', longTabs);
  await waitFor(() => js("document.querySelectorAll('.tab-row').length === 40"));
  assert.equal(await js("document.getElementById('setup').open"), false, '首次连接后收起配对说明');
  assert.equal(await js("document.activeElement.matches('#setup summary')"), true, '收起配对说明时保留可操作的键盘焦点');
  assert.equal(await js("document.getElementById('notice').textContent"), '', '自动同步不显示重复成功提示');
  assert.equal(await js("document.querySelector('.group').getBoundingClientRect().top < 280"), true, '紧凑布局应让列表在首屏靠前显示');
  assert.equal(await js("Array.from(document.querySelectorAll('.browser-label, .tab-time')).every(element => element.hidden)"), true, '单一来源不重复标注浏览器，未知时间不逐项显示');
  await js("document.getElementById('setup').open=true");
  longTabs[0].title += '（同步）';
  await post('chrome-test', 'Chrome', longTabs);
  await waitFor(() => js("document.getElementById('groups').textContent.includes('（同步）')"));
  assert.equal(await js("document.getElementById('setup').open"), true, '主动展开的配对说明不被后续同步收起');
  await js("document.getElementById('setup').open=false");
  const selectedBeforeScroll = await js("Array.from(document.querySelectorAll('.tab-row input:checked'), input => input.dataset.tabId)");
  await js('window.scrollTo(0, 600)');
  await waitFor(() => js("!document.getElementById('back-to-top').hidden"));
  assert.equal(await js("(() => { const rect=document.getElementById('close-tabs').getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; })()"), true, '长列表滚动时关闭操作保持可见');
  assert.equal(await js("(() => { const button = document.getElementById('back-to-top'); const rect = button.getBoundingClientRect(); return button.getAttribute('aria-label') === '回到顶部' && rect.width >= 44 && rect.height >= 44 && rect.bottom <= innerHeight && rect.right <= innerWidth; })()"), true, '按钮应有可访问名称且固定在视口内');
  await mkdir('artifacts', { recursive: true });
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await writeFile('artifacts/back-to-top-preview.png', (await window.webContents.capturePage()).toPNG());
  await js("document.getElementById('back-to-top').click()");
  await waitFor(() => js("window.scrollY === 0 && document.getElementById('back-to-top').hidden"));
  assert.equal(await js('document.activeElement.id'), 'page-title', '回到顶部后焦点应移至页面标题');
  await js('window.scrollTo(0, 600)');
  await waitFor(() => js("!document.getElementById('back-to-top').hidden"));
  await js("document.getElementById('back-to-top').focus()");
  window.focus();
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await waitFor(() => js('window.scrollY === 0'));
  assert.equal(await js('document.activeElement.id'), 'page-title', '键盘也应可激活回到顶部');
  window.webContents.debugger.attach('1.3');
  try {
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await js("matchMedia('(prefers-reduced-motion: reduce)').matches"), true);
    await js('window.scrollTo(0, 600)');
    await waitFor(() => js("!document.getElementById('back-to-top').hidden"));
    assert.equal(await js("document.getElementById('back-to-top').click(); window.scrollY"), 0, '减少动态效果时应直接返回，不播放滚动动画');
  } finally { window.webContents.debugger.detach(); }
  assert.deepEqual(await js("Array.from(document.querySelectorAll('.tab-row input:checked'), input => input.dataset.tabId)"), selectedBeforeScroll, '回到顶部不应改变勾选');
  await js('window.scrollTo(0, 600)');
  await waitFor(() => js("!document.getElementById('back-to-top').hidden"));
  await post('chrome-test', 'Chrome', []);
  await waitFor(() => js("document.querySelectorAll('.tab-row').length === 0 && document.getElementById('back-to-top').hidden"));
  const received = [];
  const receiveClose = async (sourceId, execute) => {
    const stop = new AbortController();
    const response = await fetch('http://127.0.0.1:37843/commands', { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, signal: stop.signal,
      body: JSON.stringify({ sourceId, sessionId: `${sourceId}-session` }),
    });
    assert.equal(response.status, 200);
    const done = response.json().then(async ({ command }) => {
      if (!command) return;
      received.push({ sourceId, command });
      const results = await execute(command);
      const result = await fetch('http://127.0.0.1:37843/results', { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId, sessionId: `${sourceId}-session`, requestId: command.requestId, results }),
      });
      assert.equal(result.status, 200);
    }).catch((error) => { if (!stop.signal.aborted) throw error; });
    return { done, stop };
  };
  const rangeTabs = (name, count, start) => Array.from({ length: count }, (_, index) => ({ id: start + index,
    title: `${name} 第${index + 1}章`, url: `https://example.com/range/${start + index}` }));
  const smallGroup = rangeTabs('远山', 2, 200);
  const mediumGroup = rangeTabs('深海', 3, 300);
  const largeGroup = rangeTabs('星河', 5, 500);
  const chromeRangeTabs = [...smallGroup, ...mediumGroup, { id: 900, title: '独立页面', url: 'https://example.com/single' }];
  const applyRange = (min, max = '') => js(`document.getElementById('group-min').value=${JSON.stringify(String(min))}; document.getElementById('group-max').value=${JSON.stringify(String(max))}; document.getElementById('group-min').dispatchEvent(new Event('input')); document.getElementById('group-filter').requestSubmit()`);
  await post('chrome-test', 'Chrome', chromeRangeTabs);
  await post('edge-test', 'Edge', largeGroup);
  await waitFor(() => js("document.getElementById('group-count').textContent === '3'"));
  assert.equal(await js("document.getElementById('tab-count').textContent"), '11', '默认沿用全部同步标签页统计');
  const search = (query) => js(`document.getElementById('tab-search').value=${JSON.stringify(query)}; document.getElementById('tab-search').dispatchEvent(new Event('input'))`);
  await search('深海');
  assert.equal(await js("document.querySelectorAll('.tab-row').length"), 3, '按标题搜索');
  assert.equal(await js("document.getElementById('tab-count').textContent"), '3');
  assert.equal(await js("document.getElementById('selected-count').textContent"), '2', '隐藏项不计入关闭数量');
  await search('EXAMPLE.COM/RANGE/300');
  assert.equal(await js("document.querySelectorAll('.tab-row').length"), 1, '网址搜索不区分大小写，允许只显示组内一项');
  assert.equal(await js("document.querySelector('.group-size').textContent"), '1 / 3 项');
  await js("document.querySelector('.group-checkbox').click()");
  await search('');
  assert.equal(await js("document.querySelector('.tab-row input[data-tab-id=\"chrome-test:300\"]').checked"), false);
  assert.equal(await js("document.querySelector('.tab-row input[data-tab-id=\"chrome-test:301\"]').checked"), true, '全选显示项不修改隐藏的组内项');
  await js("document.querySelector('.tab-row input[data-tab-id=\"chrome-test:300\"]').click()");
  await search('EXAMPLE.COM/RANGE/300');
  const searchReceiver = await receiveClose('chrome-test', async (command) => {
    assert.equal(command.type, 'close-tabs');
    assert.deepEqual(command.tabs.map(tab => tab.id), [300], '搜索后关闭只能包含显示的勾选项');
    return [{ id: 300, status: 'skipped', error: '模拟保留搜索项' }];
  });
  const searchConfirm = dialog.showMessageBox;
  dialog.showMessageBox = async (_window, options) => {
    assert.ok(options.message.includes('1 个'));
    assert.ok(!options.detail.includes('/range/301'), '确认清单不包含同组隐藏项');
    return { response: 1 };
  };
  await js("document.getElementById('close-tabs').click()");
  await searchReceiver.done;
  await waitFor(() => js("document.getElementById('notice').textContent.includes('模拟保留搜索项') && !document.getElementById('tab-search').disabled"));
  dialog.showMessageBox = searchConfirm;
  received.length = 0;
  await search('');
  await js("document.getElementById('only-selected').click()");
  assert.equal(await js("document.querySelectorAll('.tab-row').length"), 7);
  await search('深海');
  assert.equal(await js("document.querySelectorAll('.tab-row').length"), 2, '搜索和只看已选共同生效');
  await writeFile('artifacts/search-preview.png', (await window.webContents.capturePage()).toPNG());
  await search('');
  await js("document.querySelector('.tab-row input[data-tab-id=\"chrome-test:300\"]').focus(); document.activeElement.click()");
  assert.equal(await js("document.querySelectorAll('.tab-row').length"), 6, '只看已选中取消勾选立即移除');
  assert.equal(await js("document.activeElement.matches('.tab-row input')"), true, '消失项的焦点移到仍显示的项');
  await js("document.getElementById('only-selected').click()");
  assert.equal(await js("document.querySelectorAll('.tab-row').length"), 10);
  await js("document.querySelector('.tab-row input[data-tab-id=\"chrome-test:300\"]').click()");
  await search('不存在的标题');
  assert.equal(await js("document.querySelectorAll('.group').length"), 0);
  assert.equal(await js("document.getElementById('close-tabs').disabled"), true);
  await search('');
  const selectedBeforeFocus = await js("document.getElementById('selected-count').textContent");
  const focusReceiver = await receiveClose('edge-test', async (command) => {
    assert.equal(command.type, 'focus-tab');
    assert.equal(command.tabs.length, 1);
    assert.equal(command.tabs[0].id, 500);
    assert.equal(await js("document.getElementById('tab-search').disabled && document.getElementById('only-selected').disabled && document.getElementById('close-tabs').disabled"), true);
    return [{ id: 500, status: 'focused' }];
  });
  await js("document.querySelector('.locate-tab[data-focus-tab-id=\"edge-test:500\"]').click()");
  await focusReceiver.done;
  await waitFor(() => js("document.getElementById('notice').textContent === '已定位原标签页。' && !document.getElementById('tab-search').disabled"));
  assert.equal(await js("document.getElementById('selected-count').textContent"), selectedBeforeFocus, '定位按钮不改变勾选');
  assert.equal(await js("document.activeElement.dataset.focusTabId"), 'edge-test:500');
  received.length = 0;
  await post('chrome-test', 'Chrome', chromeRangeTabs, false);
  await js("document.querySelector('.locate-tab[data-focus-tab-id=\"chrome-test:300\"]').click()");
  await waitFor(() => js("document.getElementById('notice').textContent.includes('扩展 0.4.0')"));
  await post('chrome-test', 'Chrome', chromeRangeTabs);
  await search('');
  await js("document.querySelector('.tab-row input[data-tab-id=\"chrome-test:201\"]').click()");
  await applyRange(3);
  assert.equal(await js("document.getElementById('group-count').textContent"), '2');
  assert.equal(await js("document.getElementById('tab-count').textContent"), '8');
  assert.equal(await js("document.getElementById('tab-count-label').textContent"), '筛选内标签页');
  assert.equal(await js("document.getElementById('selected-count').textContent"), '6', '隐藏分组的勾选不计入关闭数量');
  const chromeRangeReceiver = await receiveClose('chrome-test', async (command) => {
    assert.deepEqual(command.tabs.map((tab) => tab.id).sort(), [300, 301]);
    return command.tabs.map((tab) => ({ id: tab.id, status: 'skipped', error: '模拟端保留标签页' }));
  });
  const edgeRangeReceiver = await receiveClose('edge-test', async (command) => {
    assert.deepEqual(command.tabs.map((tab) => tab.id).sort(), [500, 501, 502, 503]);
    return command.tabs.map((tab) => ({ id: tab.id, status: 'skipped', error: '模拟端保留标签页' }));
  });
  const originalConfirm = dialog.showMessageBox;
  dialog.showMessageBox = async (_window, options) => {
    assert.ok(options.message.includes('6 个'));
    assert.ok(!options.detail.includes('远山'), '确认清单不得包含被数量筛选隐藏的分组');
    assert.equal(await js("Array.from(document.querySelectorAll('#group-filter input, #group-filter button')).every(control => control.disabled)"), true, '关闭期间禁用数量筛选');
    return { response: 1 };
  };
  await js("document.getElementById('close-tabs').click()");
  await Promise.all([chromeRangeReceiver.done, edgeRangeReceiver.done]);
  await waitFor(() => js("document.getElementById('notice').textContent.includes('跳过 6 个') && !document.getElementById('group-min').disabled"));
  dialog.showMessageBox = originalConfirm;
  received.length = 0;
  await applyRange(4, 4);
  assert.equal(await js("document.querySelectorAll('.group').length"), 0);
  assert.equal(await js("document.getElementById('close-tabs').disabled"), true);
  assert.equal(await js("document.querySelector('#empty h2').textContent"), '没有符合项数条件的分组');
  assert.equal(await js("document.getElementById('show-setup').hidden"), true);
  await applyRange(6, 3);
  assert.equal(await js("document.getElementById('group-max').validity.customError"), true);
  assert.ok((await js("document.getElementById('group-filter-note').textContent")).includes('4–4'), '无效范围不得替换已应用的条件');
  await applyRange(2.5);
  assert.equal(await js("document.getElementById('group-min').validity.stepMismatch"), true, '只允许整数项数');
  await applyRange(2, 3);
  assert.equal(await js("document.getElementById('group-count').textContent"), '2');
  assert.equal(await js("document.getElementById('tab-count').textContent"), '5');
  await applyRange(2, 2);
  assert.equal(await js("document.querySelectorAll('.tab-row').length"), 2);
  assert.equal(await js("document.querySelector('.tab-row input[data-tab-id=\"chrome-test:201\"]').checked"), true, '隐藏后重新显示应保留手动勾选');
  await post('chrome-test', 'Chrome', [...chromeRangeTabs, ...rangeTabs('远山', 1, 202)]);
  await waitFor(() => js("document.getElementById('group-count').textContent === '0'"));
  await post('chrome-test', 'Chrome', chromeRangeTabs);
  await waitFor(() => js("document.getElementById('group-count').textContent === '1'"));
  await js("document.getElementById('source-filter').value='edge-test'; document.getElementById('source-filter').dispatchEvent(new Event('change'))");
  assert.equal(await js("document.getElementById('group-count').textContent"), '0', '数量条件应与浏览器来源一起生效');
  await js("document.getElementById('source-filter').value=''; document.getElementById('source-filter').dispatchEvent(new Event('change')); document.querySelector('#group-filter button[type=reset]').click()");
  assert.equal(await js("document.getElementById('group-count').textContent"), '3');
  assert.equal(await js("document.getElementById('tab-count').textContent"), '11');
  assert.deepEqual(await js("[document.getElementById('group-min').value, document.getElementById('group-max').value]"), ['2', '']);
  assert.equal(await js("document.querySelector('.tab-row input[data-tab-id=\"chrome-test:201\"]').checked"), true);
  await post('chrome-test', 'Chrome', []);
  await post('edge-test', 'Edge', []);
  await waitFor(() => js("document.getElementById('tab-count').textContent === '0'"));
  const tabs = [
    { id: 10, title: '星河旅行 1-20 整理版', url: 'https://example.com/novel/20' },
    { id: 11, title: '星河旅行 1-30 更新版', url: 'https://example.com/novel/30' },
  ];
  await post('chrome-test', 'Chrome', tabs);
  await waitFor(() => js("document.getElementById('selected-count').textContent === '1'"));
  assert.equal(await js("document.querySelectorAll('.group').length"), 1);
  assert.deepEqual(await groupSelection(), [{ checked: false, indeterminate: true, selected: 1 }]);
  assert.equal(await js("document.getElementById('auto-preselect').getAttribute('aria-checked')"), 'true', '首次默认开启自动预选');
  await js("document.getElementById('auto-preselect').focus(); document.getElementById('auto-preselect').click()");
  assert.equal(await js('document.activeElement.id'), 'auto-preselect');
  assert.equal(await js("document.getElementById('auto-preselect').getAttribute('aria-checked')"), 'false');
  assert.equal(await js("document.getElementById('selected-count').textContent"), '0', '关闭开关应取消自动勾选');
  assert.equal(await js("document.getElementById('close-tabs').disabled"), true);
  await js("document.querySelector('.tab-row input[data-tab-id=\"chrome-test:11\"]').click()");
  const extraTab = { id: 12, title: '星河旅行 1-25 整理版', url: 'https://example.com/novel/25' };
  await post('chrome-test', 'Chrome', [...tabs, extraTab]);
  await waitFor(() => js("document.getElementById('tab-count').textContent === '3'"));
  assert.deepEqual(await js("Array.from(document.querySelectorAll('.tab-row input'), input => [input.dataset.tabId, input.checked])"), [
    ['chrome-test:11', true], ['chrome-test:12', false], ['chrome-test:10', false],
  ], '关闭后新同步项不自动勾选，人工选择保留');
  await js("document.getElementById('direction').value='asc'; document.getElementById('direction').dispatchEvent(new Event('change'))");
  assert.equal(await js("document.getElementById('selected-count').textContent"), '1', '关闭时切换排序不清空人工选择');
  assert.ok((await js("document.getElementById('notice').textContent")).includes('自动预选保持关闭'));
  await post('chrome-test', 'Chrome', tabs);
  await waitFor(() => js("document.getElementById('tab-count').textContent === '2'"));
  await js("document.getElementById('direction').value='desc'; document.getElementById('direction').dispatchEvent(new Event('change')); document.querySelector('.tab-row input[data-tab-id=\"chrome-test:11\"]').click(); document.querySelector('.tab-row input[data-tab-id=\"chrome-test:10\"]').click(); document.getElementById('auto-preselect').click()");
  await post('chrome-test', 'Chrome', [...tabs, extraTab]);
  await waitFor(() => js("document.getElementById('tab-count').textContent === '3'"));
  assert.deepEqual(await js("Array.from(document.querySelectorAll('.tab-row input'), input => [input.dataset.tabId, input.checked])"), [
    ['chrome-test:11', false], ['chrome-test:12', true], ['chrome-test:10', true],
  ], '重新开启应预选非手动项，并保留手动勾选与取消');
  await js("document.getElementById('auto-preselect').click()");
  assert.equal(await js("document.getElementById('selected-count').textContent"), '1', '关闭只取消自动项，不取消手动勾选');
  assert.equal(await js("localStorage.getItem('auto-preselect')"), 'false');
  const preselectReloaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
  window.webContents.reload();
  await preselectReloaded;
  await waitFor(() => js("Boolean(document.getElementById('connection-code').value)"));
  assert.equal(await js("document.getElementById('auto-preselect').getAttribute('aria-checked')"), 'false', '重载后应沿用关闭状态');
  assert.equal(await js("document.getElementById('selected-count').textContent"), '0', '手动选择不跨重载保存，关闭时也不恢复自动项');
  await post('chrome-test', 'Chrome', tabs);
  await waitFor(() => js("document.getElementById('tab-count').textContent === '2'"));
  await js("document.getElementById('auto-preselect').click()");
  assert.equal(await js("localStorage.getItem('auto-preselect')"), 'true');
  assert.deepEqual(await groupSelection(), [{ checked: false, indeterminate: true, selected: 1 }], '重新开启后沿用默认自然排序建议');
  await js("document.querySelector('.group-select').click()");
  assert.deepEqual(await groupSelection(), [{ checked: true, indeterminate: false, selected: 2 }]);
  assert.equal(await js("document.getElementById('selected-count').textContent"), '2');
  await js("document.querySelector('.group-checkbox').click()");
  assert.deepEqual(await groupSelection(), [{ checked: false, indeterminate: false, selected: 0 }]);
  assert.equal(await js("document.getElementById('close-tabs').disabled"), true);
  await js("document.querySelectorAll('.tab-row input')[1].click()");
  assert.deepEqual(await groupSelection(), [{ checked: false, indeterminate: true, selected: 1 }]);
  await js("document.querySelector('.tab-row input').focus(); document.querySelector('.tab-row input').click()");
  tabs[1].title += '（校对）';
  await post('chrome-test', 'Chrome', tabs);
  await waitFor(() => js("document.getElementById('groups').textContent.includes('（校对）')"));
  assert.equal(await js("document.activeElement?.dataset.tabId"), 'chrome-test:11', '同步后应保留当前标签页的键盘焦点');
  assert.equal(await js("document.getElementById('selected-count').textContent"), '2');
  assert.deepEqual(await groupSelection(), [{ checked: true, indeterminate: false, selected: 2 }]);
  await js("document.querySelector('.group-checkbox').focus(); document.querySelector('.group-checkbox').click()");
  tabs[1].title = '星河旅行 1-30 更新版（复核）';
  await post('chrome-test', 'Chrome', tabs);
  await waitFor(() => js("document.getElementById('groups').textContent.includes('（复核）')"));
  assert.equal(await js("document.activeElement?.classList.contains('group-checkbox')"), true, '同步后应保留组勾选框焦点');
  assert.deepEqual(await groupSelection(), [{ checked: false, indeterminate: false, selected: 0 }], '同步后应保留整组取消勾选');
  assert.equal(await js("document.getElementById('selected-count').textContent"), '0');
  await js("document.getElementById('open-settings').focus(); document.getElementById('open-settings').click()");
  assert.equal(await js("document.getElementById('settings-dialog').matches(':modal')"), true);
  assert.equal(await js('document.activeElement.id'), 'close-settings');
  window.focus();
  // 输入事件异步送达，等待焦点变化后再发下一次 Tab。
  for (let index = 0; index < 12; index++) {
    await js('window.focusBeforeTab = document.activeElement');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await waitFor(() => js("document.activeElement !== window.focusBeforeTab && document.getElementById('settings-dialog').contains(document.activeElement)"));
    assert.equal(await js("document.getElementById('settings-dialog').contains(document.activeElement)"), true, 'Tab 焦点应限制在设置中');
  }
  await js("document.getElementById('close-settings').focus()");
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] });
  await waitFor(() => js("document.activeElement.classList.contains('delete-rule')"));
  assert.equal(await js("document.activeElement.classList.contains('delete-rule')"), true, 'Shift+Tab 应循环到最后一张卡片的按钮，跳过隐藏表单');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
  await waitFor(() => js("document.activeElement.id === 'close-settings'"));
  assert.equal(await js('document.activeElement.id'), 'close-settings', 'Tab 应从末项循环到首项');
  await js("document.getElementById('ignore-nav').click()");
  assert.equal(await js('document.activeElement.id'), 'ignore-title');
  await js("document.getElementById('add-rule').click(); document.getElementById('ignore-name').value='未保存的规则'");
  assert.equal(await js("document.getElementById('rule-editor').hidden"), false, '添加按钮打开表单');
  assert.equal(await js('document.activeElement.id'), 'ignore-name');
  await js("document.getElementById('cancel-rule').focus()");
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
  await waitFor(() => js("document.activeElement.id === 'close-settings'"));
  assert.equal(await js('document.activeElement.id'), 'close-settings', '表单模式下焦点应跳过隐藏卡片');
  await js("document.getElementById('close-settings').click()");
  assert.equal(await js("document.getElementById('settings-dialog').open"), false);
  assert.equal(await js('document.activeElement.id'), 'open-settings', '关闭设置应恢复入口焦点');
  assert.equal(await js("document.getElementById('selected-count').textContent"), '0', '打开和关闭设置不应改变人工勾选');
  assert.deepEqual(await js('window.tabTidy.getState().then(state => state.ignoreRules)'), [legacyRule], '关闭设置不应保存草稿');
  await js("document.getElementById('open-settings').focus(); document.getElementById('open-settings').click()");
  assert.equal(await js("document.getElementById('ignore-name').value"), '未保存的规则', '重开设置应保留填写草稿');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor(() => js("!document.getElementById('settings-dialog').open"));
  assert.equal(await js('document.activeElement.id'), 'open-settings', 'Esc 应恢复入口焦点');
  const contrastColors = await js("['.tab-url', '.tab-time', '.note', '.source small', '.muted', '.stats', '.group-size', '.sidebar-current', '.rule-card-label', '.rule-chips span'].map(selector => ({ selector, color: getComputedStyle(document.querySelector(selector)).color }))");
  const luminance = (rgb) => rgb.map((value) => value / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  for (const { selector, color } of contrastColors) {
    const foreground = luminance(color.match(/\d+/g).slice(0, 3).map(Number));
    const backgrounds = selector === '.sidebar-current' ? [[220, 231, 247]]
      : [[255, 255, 255], [237, 245, 255], [248, 249, 251], [233, 237, 244]];
    for (const background of backgrounds) {
      assert.ok((luminance(background) + 0.05) / (foreground + 0.05) >= 4.5, `${selector} 文字对比度应至少为 4.5:1`);
    }
  }
  await js("document.getElementById('sort-by').value='time'; document.getElementById('sort-by').dispatchEvent(new Event('change'))");
  assert.equal(await js("document.getElementById('sort-note').classList.contains('sr-only')"), false);
  assert.ok((await js("document.getElementById('sort-note').textContent")).includes('打开时间未知'), '时间排序保留必要的未知时间提示');
  assert.equal(await js("document.getElementById('selected-count').textContent"), '0');
  assert.deepEqual(await groupSelection(), [{ checked: false, indeterminate: false, selected: 0 }]);
  await js("document.querySelector('.group-checkbox').click()");
  assert.equal(await js("document.getElementById('selected-count').textContent"), '2', '时间未知时仍允许人工整组勾选');
  await js("document.getElementById('sort-by').value='natural'; document.getElementById('direction').value='asc'; document.getElementById('sort-by').dispatchEvent(new Event('change'))");
  assert.equal(await js("document.querySelector('.tab-title').textContent"), tabs[0].title);
  assert.deepEqual(await groupSelection(), [{ checked: false, indeterminate: true, selected: 1 }], '切换排序仍按原规则重新预选');
  const chromeReceiver = await receiveClose('chrome-test', async () => { throw new Error('未确认或未选中的 Chrome 标签页不应收到关闭指令'); });
  await waitFor(() => js("document.querySelector('.source-state').textContent === '已连接'"));
  let confirm;
  dialog.showMessageBox = async (_window, options) => {
    assert.equal(options.defaultId, 0);
    assert.equal(options.cancelId, 0);
    assert.ok(options.detail.includes(tabs[1].title));
    assert.ok(options.detail.includes(tabs[1].url));
    return new Promise((resolve) => { confirm = resolve; });
  };
  await js("document.getElementById('close-tabs').click()");
  await waitFor(() => Boolean(confirm));
  assert.equal(await js("document.getElementById('close-tabs').disabled"), true);
  assert.equal(await js("Array.from(document.querySelectorAll('.group-checkbox, .tab-row input')).every(input => input.disabled)"), true);
  assert.equal(await js("document.getElementById('auto-preselect').disabled"), true, '确认关闭期间禁用开关');
  assert.equal(await js("document.getElementById('source-filter').disabled"), true, '确认关闭期间不能切换来源');
  confirm({ response: 0 });
  await waitFor(() => js("document.getElementById('notice').textContent.includes('已取消关闭')"));
  assert.equal(received.length, 0, '取消确认不能发送关闭指令');
  assert.equal(await js("document.getElementById('selected-count').textContent"), '1');
  const edgeTabs = [
    { id: 10, title: '山海故事 1-9 完整版', url: 'https://example.com/other/9' },
    { id: 11, title: '乙分享 山海故事', url: 'https://example.com/other/10' },
  ];
  await post('edge-test', 'Edge', edgeTabs);
  await waitFor(() => js("document.querySelectorAll('.group').length === 2"));
  assert.equal(await js("Array.from(document.querySelectorAll('.browser-label')).every(element => !element.hidden)"), true, '混合来源仍能识别各标签页的浏览器');
  assert.deepEqual(await js("Array.from(document.getElementById('source-filter').options, option => option.textContent)"), ['全部浏览器', 'Chrome', 'Edge']);
  await post('edge-test', 'Chrome', edgeTabs);
  await waitFor(() => js("document.getElementById('source-filter').options[1].textContent.includes('chrome')"));
  assert.deepEqual(await js("Array.from(document.getElementById('source-filter').options, option => option.textContent)"), ['全部浏览器', 'Chrome · chrome', 'Chrome · edge-t'], '同浏览器多个配置仍显示来源标识');
  await post('edge-test', 'Edge', edgeTabs);
  await waitFor(() => js("document.getElementById('source-filter').options[2].textContent === 'Edge'"));
  await js("document.querySelectorAll('.group-checkbox')[0].click()");
  assert.deepEqual(await groupSelection(), [
    { checked: true, indeterminate: false, selected: 2 },
    { checked: false, indeterminate: true, selected: 1 },
  ], '整组勾选不应影响另一组');
  assert.equal(await js("document.getElementById('selected-count').textContent"), '3');
  await js("document.querySelectorAll('.group-checkbox')[0].click(); document.querySelectorAll('.group-checkbox')[1].click()");
  assert.deepEqual(await js("Array.from(document.getElementById('source-filter').options, option => option.value)"), ['', 'chrome-test', 'edge-test']);
  await js("document.getElementById('source-filter').value='chrome-test'; document.getElementById('source-filter').dispatchEvent(new Event('change'))");
  assert.equal(await js("document.querySelectorAll('.group').length"), 1);
  assert.equal(await js("document.getElementById('tab-count').textContent"), '2');
  assert.equal(await js("document.getElementById('selected-count').textContent"), '0');
  await js("document.querySelector('.tab-row input').click(); document.getElementById('source-filter').value='edge-test'; document.getElementById('source-filter').dispatchEvent(new Event('change')); document.getElementById('source-filter').focus(); window.groupBeforeConnection=document.querySelector('.group')");
  assert.equal(await js("document.getElementById('selected-count').textContent"), '2', '切换来源保留该来源此前的手动勾选');
  assert.equal(await js("Array.from(document.querySelectorAll('.tab-row input')).every(input => input.dataset.tabId.startsWith('edge-test:'))"), true);
  const edgeReceiver = await receiveClose('edge-test', async (command) => {
    assert.deepEqual(command.tabs.map((tab) => tab.id).sort(), [10, 11]);
    await post('edge-test', 'Edge', [{ ...edgeTabs[1], url: 'https://example.com/changed' }]);
    return [{ id: 10, status: 'closed' }, { id: 11, status: 'skipped', error: '页面已变化' }];
  });
  await waitFor(() => js("document.querySelectorAll('.source-state')[1].textContent === '已连接'"));
  assert.equal(await js('document.activeElement.id'), 'source-filter', '连接状态更新不打断来源选择');
  assert.equal(await js("window.groupBeforeConnection === document.querySelector('.group')"), true, '仅连接状态变化时不重建标签页列表');
  dialog.showMessageBox = async (_window, options) => {
    assert.ok(options.message.includes('2 个'));
    assert.ok(options.detail.includes(edgeTabs[0].title));
    return { response: 1 };
  };
  await js("document.getElementById('close-tabs').click()");
  await waitFor(() => js("document.getElementById('notice').textContent.includes('已关闭 1 个标签页；跳过 1 个')"));
  await edgeReceiver.done;
  assert.equal(received.length, 1);
  assert.equal(received[0].sourceId, 'edge-test');
  assert.equal(await js("document.getElementById('tab-count').textContent"), '1', '统计只计算当前 Edge 来源');
  assert.equal(await js("document.getElementById('close-tabs').disabled"), true);
  await post('chrome-test', 'Chrome', tabs);
  await waitFor(() => js("document.getElementById('notice').textContent.includes('页面已变化')"));
  assert.ok((await js("document.getElementById('notice').textContent")).includes('已关闭 1 个'), '后续同步不能覆盖关闭结果');
  chromeReceiver.stop.abort();
  await chromeReceiver.done;
  await waitFor(() => js("document.querySelector('.source-state').textContent.includes('等待重连')"));
  await js("document.getElementById('source-filter').value=''; document.getElementById('source-filter').dispatchEvent(new Event('change'))");
  assert.equal(await js("document.getElementById('tab-count').textContent"), '3');
  assert.equal(await js("document.getElementById('selected-count').textContent"), '1', '隐藏来源的手动选择保留，且未随 Edge 关闭');
  await post('edge-test', 'Edge', edgeTabs);
  await waitFor(() => js("document.querySelectorAll('.group').length === 2"));
  await js("document.getElementById('direction').dispatchEvent(new Event('change'))");
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/desktop-preview.png', (await window.webContents.capturePage()).toPNG());
  await post('edge-test', 'Edge', [
    { id: 10, title: '<img src=x onerror="window.injected=1">', url: 'https://example.com/same' },
    { id: 11, title: '安全标题', url: 'https://example.com/same' },
  ]);
  await waitFor(() => js("document.getElementById('groups').textContent.includes('<img')"));
  assert.equal(await js("document.querySelectorAll('#groups img').length"), 0);
  assert.equal(await js('window.injected'), undefined);
  await post('edge-test', 'Edge', ['a xxxx', 'bc xxxx'].map((title, index) => ({ id: index + 31, title, url: `https://other.example/${index}` })));
  const noisy = ['a xxxx', 'bc xxxx', 'd xxxx'].map((title, index) => ({ id: index + 21, title, url: `https://noise.example/${index}` }));
  await post('chrome-test', 'Chrome', noisy);
  await waitFor(() => js("document.querySelectorAll('.tab-row').length === 5"));
  assert.ok((await js("Array.from(document.getElementById('website-hosts').options, option => option.value)")).includes('noise.example'));
  await js("document.getElementById('open-settings').focus(); document.getElementById('open-settings').click(); document.getElementById('cancel-rule').click(); document.getElementById('add-rule').click(); document.getElementById('ignore-name').value='小说站'; document.getElementById('ignore-domains').value='NOISE.EXAMPLE\\narchive.example'; document.getElementById('ignore-words').value='xxxx\\n下载专区'; document.getElementById('save-ignore').focus(); document.getElementById('save-ignore').click()");
  await waitFor(() => js("document.getElementById('notice').textContent.includes('忽略规则已保存')"));
  assert.ok((await js("document.getElementById('settings-notice').textContent")).includes('忽略规则已保存'), '保存结果应在设置中可见');
  assert.equal(await js("document.activeElement.matches('.edit-rule[data-rule-index=\"1\"]')"), true, '保存后应聚焦对应卡片的编辑按钮');
  assert.equal(await js("document.getElementById('rule-editor').hidden"), true, '保存后返回卡片列表');
  assert.equal(await js("document.querySelectorAll('.rule-card').length"), 2);
  assert.equal(await js("document.querySelectorAll('.rule-card h4')[1].textContent"), '小说站');
  assert.deepEqual(await js("Array.from(document.querySelectorAll('.rule-card:nth-child(2) .rule-domains .rule-chips span'), chip => chip.textContent)"), ['noise.example', 'archive.example']);
  assert.deepEqual(await js("Array.from(document.querySelectorAll('.rule-card:nth-child(2) .rule-words .rule-chips span'), chip => chip.textContent)"), ['xxxx', '下载专区']);
  assert.equal(await js("document.querySelectorAll('.tab-row').length"), 2);
  assert.equal(await js("Array.from(document.querySelectorAll('.tab-row input')).every(input => input.dataset.tabId.startsWith('edge-test:'))"), true, '规则不能影响另一网站');
  const noiseRule = { name: '小说站', domains: ['noise.example', 'archive.example'], ignoredNames: ['xxxx', '下载专区'] };
  assert.deepEqual(JSON.parse(await readFile(join(temporary, 'ignored-names.json'), 'utf8')), [legacyRule, noiseRule]);
  await post('chrome-test', 'Chrome', [...noisy, { id: 24, title: 'efg 下载专区', url: 'https://archive.example/3' }]);
  await waitFor(() => js("document.getElementById('tab-count').textContent === '6'"));
  assert.equal(await js("document.querySelectorAll('.tab-row').length"), 2, '后续同步应自动应用保存的规则');
  const bookTabs = [
    { id: 25, title: '星河旅行 1-2 - xxxx', url: 'https://noise.example/book/2' },
    { id: 26, title: '星河旅行 1-10 - xxxx', url: 'https://archive.example/book/10' },
  ];
  await post('chrome-test', 'Chrome', bookTabs);
  await waitFor(() => js("document.querySelectorAll('.group').length === 2"));
  assert.deepEqual(await js("Array.from(document.querySelectorAll('.group:first-child .tab-title'), element => element.textContent)"), bookTabs.map((tab) => tab.title), '应显示并按原始标题排序');
  await js("document.getElementById('close-settings').click(); document.getElementById('auto-preselect').click(); document.querySelector('.tab-row input[data-tab-id=\"chrome-test:25\"]').click(); document.getElementById('open-settings').focus(); document.getElementById('open-settings').click()");
  assert.equal(await js("document.getElementById('selected-count').textContent"), '1', '关闭自动预选后仍可手动勾选');
  await js("document.querySelector('.edit-rule[data-rule-index=\"1\"]').click(); document.getElementById('ignore-words').value='draft'; document.getElementById('ignore-words').focus()");
  await post('chrome-test', 'Chrome', [...bookTabs, { id: 27, title: '独立页面', url: 'https://fresh.example/page' }]);
  await waitFor(() => js("document.getElementById('tab-count').textContent === '5'"));
  assert.equal(await js("document.getElementById('ignore-words').value"), 'draft');
  assert.equal(await js('document.activeElement.id'), 'ignore-words', '同步不能打断设置编辑或丢失焦点');
  assert.equal(await js("document.getElementById('rule-editor').hidden"), false, '浏览器同步不应退出编辑');
  const loaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
  window.webContents.reload();
  await loaded;
  await waitFor(() => js("Boolean(document.getElementById('connection-code').value)"));
  assert.equal(await js("document.querySelectorAll('.group').length"), 2, '重新加载界面后规则应自动应用');
  assert.equal(await js("document.getElementById('settings-dialog').open"), false, '重载后设置应默认关闭');
  assert.equal(await js("document.getElementById('auto-preselect').getAttribute('aria-checked')"), 'false');
  await js("document.querySelector('.tab-row input[data-tab-id=\"chrome-test:25\"]').click()");
  await js("document.getElementById('open-settings').focus(); document.getElementById('open-settings').click(); document.querySelector('.edit-rule[data-rule-index=\"1\"]').click()");
  assert.equal(await js("document.getElementById('ignore-name').value"), '小说站');
  assert.equal(await js("document.getElementById('ignore-domains').value"), 'noise.example\narchive.example');
  assert.equal(await js("document.getElementById('ignore-words').value"), 'xxxx\n下载专区');
  await js("document.getElementById('ignore-name').value='小说站新名称'; document.getElementById('website-hosts').value='fresh.example'; document.getElementById('website-hosts').dispatchEvent(new Event('change')); document.getElementById('website-hosts').value='fresh.example'; document.getElementById('website-hosts').dispatchEvent(new Event('change')); document.getElementById('save-ignore').click()");
  await waitFor(() => js("document.getElementById('notice').textContent.includes('忽略规则已保存')"));
  const updatedRule = { ...noiseRule, name: '小说站新名称', domains: [...noiseRule.domains, 'fresh.example'] };
  const savedRules = [legacyRule, updatedRule];
  assert.deepEqual(JSON.parse(await readFile(join(temporary, 'ignored-names.json'), 'utf8')), savedRules, '追加域名和改名应保留原忽略词，重复添加应去重');
  assert.equal(await js("document.getElementById('selected-count').textContent"), '1', '关闭自动预选时保存规则不新增勾选、不清空手动选择');
  assert.equal(await js("document.querySelector('.tab-row input[data-tab-id=\"chrome-test:25\"]').checked"), true);
  assert.ok((await js("document.getElementById('settings-notice').textContent")).includes('自动预选保持关闭'));
  await post('chrome-test', 'Chrome', [...bookTabs, { id: 27, title: 'efg 下载专区', url: 'https://fresh.example/page' }]);
  await waitFor(() => js("document.getElementById('tab-count').textContent === '5'"));
  assert.equal(await js("document.querySelectorAll('.tab-row').length"), 4, '新域名应立即共用原规则的忽略词');
  assert.ok((await js("document.getElementById('settings-notice').textContent")).includes('忽略规则已保存'), '浏览器同步不应覆盖保存结果');
  window.setSize(980, 640);
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true, '最小宽度不应横向溢出');
  assert.equal(await js("(() => { const dialog = document.getElementById('settings-dialog'); const rect = dialog.getBoundingClientRect(); const content = dialog.querySelector('.settings-content'); const nav = dialog.querySelector('.settings-nav').getBoundingClientRect(); const close = document.getElementById('close-settings').getBoundingClientRect(); const result = document.getElementById('settings-notice').getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight && dialog.scrollWidth <= dialog.clientWidth && content.scrollWidth <= content.clientWidth && nav.right <= content.getBoundingClientRect().left && nav.width > 0 && close.top >= rect.top && close.bottom <= rect.bottom && result.bottom <= innerHeight; })()"), true, '最小窗口中左右分栏无溢出，返回按钮和结果应保持可见');
  await writeFile('artifacts/settings-preview.png', (await window.webContents.capturePage()).toPNG());
  await js("document.getElementById('add-rule').click(); document.getElementById('ignore-name').value='冲突站点'; document.getElementById('ignore-domains').value='NOISE.EXAMPLE'; document.getElementById('ignore-words').value='其他词'; document.getElementById('save-ignore').click()");
  await waitFor(() => js("document.getElementById('notice').textContent.includes('已用于')"));
  assert.ok((await js("document.getElementById('settings-notice').textContent")).includes('已用于'), '保存错误应在设置中显示');
  assert.deepEqual(JSON.parse(await readFile(join(temporary, 'ignored-names.json'), 'utf8')), savedRules, '冲突域名不能覆盖旧规则');
  assert.equal(await js("document.getElementById('ignore-name').value"), '冲突站点', '保存失败应保留草稿');
  await js("document.getElementById('cancel-rule').click(); document.querySelector('.edit-rule[data-rule-index=\"1\"]').click(); document.getElementById('ignore-words').value='---'; document.getElementById('save-ignore').click()");
  await waitFor(() => js("document.getElementById('notice').textContent.includes('每个忽略词')"));
  assert.deepEqual(JSON.parse(await readFile(join(temporary, 'ignored-names.json'), 'utf8')), savedRules, '无效输入不应覆盖保存的设置');
  await js("const content=document.querySelector('.settings-content'); content.scrollTop=content.scrollHeight");
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.equal(await js("(() => { const content=document.querySelector('.settings-content').getBoundingClientRect(); const button=document.getElementById('save-ignore').getBoundingClientRect(); return button.top >= content.top && button.bottom <= content.bottom; })()"), true, '最小窗口下编辑表单的保存操作可到达');
  await writeFile('artifacts/settings-editor-preview.png', (await window.webContents.capturePage()).toPNG());
  await js("document.getElementById('cancel-rule').click()");
  assert.deepEqual(JSON.parse(await readFile(join(temporary, 'ignored-names.json'), 'utf8')), savedRules, '取消编辑不应修改原规则');
  await js("document.querySelector('.delete-rule[data-rule-index=\"1\"]').click()");
  await waitFor(() => js("document.getElementById('notice').textContent.includes('忽略规则已删除')"));
  assert.deepEqual(JSON.parse(await readFile(join(temporary, 'ignored-names.json'), 'utf8')), [legacyRule], '删除此规则应保留其他规则');
  assert.equal(await js("document.querySelectorAll('.group').length"), 1, '删除规则后应重新使用原始标题匹配');
  assert.equal(await js("document.querySelectorAll('.rule-card').length"), 1);
  await js("document.querySelector('.delete-rule[data-rule-index=\"0\"]').click()");
  await waitFor(() => js("!document.getElementById('add-rule').disabled"));
  assert.deepEqual(JSON.parse(await readFile(join(temporary, 'ignored-names.json'), 'utf8')), []);
  assert.equal(await js("document.getElementById('rules-empty').hidden"), false, '删除最后一条规则后应显示空状态');
  await js("document.getElementById('add-rule').click(); document.getElementById('ignore-name').value='<img src=x onerror=window.ruleInjected=1>'; document.getElementById('ignore-domains').value='safe.example'; document.getElementById('ignore-words').value='网站名'; document.getElementById('save-ignore').click()");
  await waitFor(() => js("!document.getElementById('add-rule').disabled"));
  assert.equal(await js("document.querySelector('.rule-card h4').textContent"), '<img src=x onerror=window.ruleInjected=1>');
  assert.equal(await js("document.querySelectorAll('#rule-cards img').length"), 0, '规则文字不能作为 HTML 执行');
  assert.equal(await js('window.ruleInjected'), undefined);
  await js("document.getElementById('close-settings').click()");
  assert.equal(await js('document.activeElement.id'), 'open-settings');
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true, '新增开关后最小窗口主界面不应横向溢出');
  await writeFile('artifacts/auto-preselect-preview.png', (await window.webContents.capturePage()).toPNG());
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  clearTimeout(timeout);
  console.log('桌面验证通过：原标签页定位与旧扩展提示、标题/网址搜索、只看已选与焦点移交、筛选内操作范围与隐藏项保留，以及排序、预选、来源、关闭、设置、最小窗口和既有回归。');
  await rm(temporary, { recursive: true, force: true });
  app.exit(0);
})().catch((error) => { console.error(error); app.exit(1); });
