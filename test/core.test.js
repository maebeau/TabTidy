import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeTabs } from '../src/core.js';

test('重复网址归组，默认自然降序保留首项并预选其余项', () => {
  const result = analyzeTabs([
    { id: 1, title: '页面 A', url: 'https://example.com/book' },
    { id: 2, title: '页面 B', url: 'https://example.com/book' },
    { id: 3, title: '独立页面', url: 'https://example.com/other' },
  ]);

  assert.equal(result.length, 1);
  assert.deepEqual(result[0].reasons, ['duplicate-url']);
  assert.deepEqual(result[0].tabs.map(({ id, selected }) => [id, selected]), [
    [2, false], [1, true],
  ]);
});

test('书名前缀相同，章节号和章节名称不同也归组并按自然顺序排列', () => {
  const result = analyzeTabs([
    { id: 9, title: '某某书 第9章 出发' },
    { id: 20, title: '某某书 第20章 重逢' },
    { id: 30, title: '某某书 第30章 归来' },
    { id: 4, title: '另一本书 第30章 归来' },
  ]);

  assert.equal(result.length, 1);
  assert.deepEqual(result[0].reasons, ['similar-title']);
  assert.deepEqual(result[0].tabs.map((tab) => tab.id), [30, 20, 9]);
});

test('数字与范围后缀、全半角和大小写差异不影响相似归组', () => {
  const groups = analyzeTabs([
    { id: 1, title: 'XXX１' },
    { id: 2, title: 'xxx1-2' },
    { id: 3, title: '某某书 1–20' },
    { id: 4, title: '某某书 1–30' },
    { id: 5, title: '无关的网页' },
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.tabs.map((tab) => tab.id)), [[2, 1], [4, 3]]);
});

test('较长标题有少量文字差异可归组，无关标题和短词不模糊归组', () => {
  const result = analyzeTabs([
    { id: 1, title: 'Understanding browser tabs and their memory' },
    { id: 2, title: 'Understanding browser tabs and memory' },
    { id: 3, title: 'Managing database connections and query plans' },
    { id: 4, title: '首页' },
    { id: 5, title: '主页' },
  ]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].tabs.map((tab) => tab.id).toSorted(), [1, 2]);
});

test('不规整标题的数字与版本说明变化可归组，原始标题保持不变', () => {
  const tabs = [
    { id: 1, title: '星河旅行 1-20 整理版', openedAt: 100 },
    { id: 2, title: '星河旅行 1-30 更新版', openedAt: 200 },
  ];
  const result = analyzeTabs(tabs);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].reasons, ['similar-title']);
  assert.deepEqual(result[0].tabs.map(({ id, title, selected }) => [id, title, selected]), [
    [2, '星河旅行 1-30 更新版', false],
    [1, '星河旅行 1-20 整理版', true],
  ]);
  assert.deepEqual(tabs, [
    { id: 1, title: '星河旅行 1-20 整理版', openedAt: 100 },
    { id: 2, title: '星河旅行 1-30 更新版', openedAt: 200 },
  ]);
});

test('相同文字片段调整顺序后仍可识别为候选', () => {
  const result = analyzeTabs([
    { id: 1, title: '前端入门指南' },
    { id: 2, title: '指南前端入门' },
  ]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].tabs.map((tab) => tab.id).toSorted(), [1, 2]);
});

test('共同主体文字在不同位置、附加说明不同也可归组', () => {
  for (const titles of [
    ['星河旅行 甲整理', '乙分享 星河旅行'],
    ['星河旅行', '星河旅行个人整理'],
    ['Chrome 标签页管理工具 使用说明', '使用教程：Chrome 标签页管理工具'],
  ]) {
    const result = analyzeTabs(titles.map((title, id) => ({ id, title })));
    assert.equal(result.length, 1, titles.join(' / '));
    assert.equal(result[0].tabs.length, 2);
  }
});

test('仅有相同版本说明、短片段或数字不足以合并无关标题', () => {
  for (const titles of [
    ['星河旅行 1-20 整理版', '山海故事 1-30 更新版'],
    ['相机参数指南 完整版', '咖啡冲煮教程 完整版'],
    ['共同词语甲乙丙丁戊己庚辛', '共同词语子丑寅卯辰巳午未'],
    ['𠮷野屋资料', '𠮷野屋菜单'],
    ['12345', '67890'],
    ['完整版', '整理版'],
    ['首页', '主页'],
  ]) {
    assert.deepEqual(analyzeTabs(titles.map((title, id) => ({ id, title }))), [], titles.join(' / '));
  }
});

test('新匹配的候选组沿用时间排序和预选，未知时间仍不自动预选', () => {
  const tabs = [
    { id: 1, title: '星河旅行 甲整理', openedAt: 200 },
    { id: 2, title: '乙分享 星河旅行', openedAt: 100 },
  ];
  for (const direction of ['asc', 'desc']) {
    const group = analyzeTabs(tabs, { sortBy: 'time', direction })[0];
    assert.deepEqual(group.tabs.map(({ id, selected }) => [id, selected]), direction === 'asc'
      ? [[2, false], [1, true]] : [[1, false], [2, true]]);
  }
  const unknown = analyzeTabs([tabs[0], { ...tabs[1], openedAt: null }], { sortBy: 'time' })[0];
  assert.deepEqual(unknown.tabs.map(({ id, selected }) => [id, selected]), [[1, false], [2, false]]);
});

test('时间排序支持升降序；自然排序支持升序', () => {
  const tabs = [
    { id: 2, title: '书 第2章', openedAt: 300 },
    { id: 10, title: '书 第10章', openedAt: 100 },
    { id: 9, title: '书 第9章', openedAt: 200 },
  ];
  const ids = (options) => analyzeTabs(tabs, options)[0].tabs.map((tab) => tab.id);
  assert.deepEqual(ids({ sortBy: 'time' }), [2, 9, 10]);
  assert.deepEqual(ids({ sortBy: 'time', direction: 'asc' }), [10, 9, 2]);
  assert.deepEqual(ids({ sortBy: 'natural', direction: 'asc' }), [2, 9, 10]);
  assert.deepEqual(analyzeTabs(tabs, { sortBy: 'time' })[0].tabs.map((tab) => tab.selected),
    [false, true, true]);
});

test('未知时间始终排在末尾，未知或并列时间的整组不自动预选', () => {
  const tabs = [
    { id: 1, title: '书A 第1章', openedAt: 100 },
    { id: 2, title: '书A 第2章', openedAt: 200 },
    { id: 3, title: '书A 第3章', openedAt: null },
    { id: 4, title: '书A 第4章' },
  ];
  for (const direction of ['asc', 'desc']) {
    const group = analyzeTabs(tabs, { sortBy: 'time', direction })[0];
    assert.deepEqual(group.tabs.map((tab) => tab.id), direction === 'asc' ? [1, 2, 3, 4] : [2, 1, 3, 4]);
    assert.ok(group.tabs.every((tab) => !tab.selected));
  }
  const tied = analyzeTabs([
    { id: 1, title: '书 第1章', openedAt: 10 },
    { id: 2, title: '书 第2章', openedAt: 10 },
    { id: 3, title: '书 第3章', openedAt: 20 },
  ], { sortBy: 'time' })[0];
  assert.deepEqual(tied.tabs.map((tab) => tab.id), [3, 1, 2]);
  assert.ok(tied.tabs.every((tab) => !tab.selected));
});

test('无效输入给出明确错误，空清单合法', () => {
  const tab = { id: 1, title: '书 第1章' };
  assert.deepEqual(analyzeTabs([]), []);
  assert.throws(() => analyzeTabs(null), /tabs must be an array/);
  for (const invalid of [null, [], {}, { id: '', title: '书' }, { id: NaN, title: '书' },
    { id: 1, title: 123 }, { ...tab, url: 'relative/path' }, { ...tab, url: 123 },
    { ...tab, openedAt: -1 }, { ...tab, openedAt: '2026-10-18' },
    { ...tab, openedAt: Infinity }, { ...tab, openedAt: 1.5 }]) {
    assert.throws(() => analyzeTabs([invalid]), TypeError);
  }
  assert.throws(() => analyzeTabs([tab, tab]), /duplicate id/);
  assert.throws(() => analyzeTabs([tab], { sortBy: 'dictionary' }), /sortBy/);
  assert.throws(() => analyzeTabs([tab], { direction: 'up' }), /direction/);
  assert.throws(() => analyzeTabs([tab], null), /options/);
});

test('不修改输入，排序并列保持原顺序，空标题不会被相似归组', () => {
  const tabs = Object.freeze([
    Object.freeze({ id: 'first', title: '同名书', selected: true }),
    Object.freeze({ id: 'second', title: '同名书', selected: false }),
    Object.freeze({ id: 'empty1', title: '' }),
    Object.freeze({ id: 'empty2', title: '' }),
  ]);
  const before = structuredClone(tabs);
  const result = analyzeTabs(tabs);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].tabs.map(({ id, selected }) => [id, selected]), [
    ['first', false], ['second', true],
  ]);
  assert.deepEqual(tabs, before);
  assert.notEqual(result[0].tabs[0], tabs[0]);
});

test('网址查询参数和片段不同不当作重复网址', () => {
  assert.deepEqual(analyzeTabs([
    { id: 1, title: '页面 A', url: 'https://example.com/?id=1#one' },
    { id: 2, title: '页面 B', url: 'https://example.com/?id=2#one' },
    { id: 3, title: '页面 C', url: 'https://example.com/?id=1#two' },
  ]), []);
});

test('候选关系传递时合并整组，收集全部原因且每个标签只出现一次', () => {
  const groups = analyzeTabs([
    { id: 1, title: 'Novel 1', url: 'https://example.com/a' },
    { id: '1', title: 'Other 3', url: 'https://example.com/b' },
    { id: 3, title: 'Novel 2', url: 'https://example.com/b' },
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].reasons, ['duplicate-url', 'similar-title']);
  assert.equal(groups[0].tabs.length, 3);
  assert.equal(new Set(groups[0].tabs.map((tab) => tab.id)).size, 3);
});
