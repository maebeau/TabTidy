import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeWebsite, normalizeIgnoredNamesByHost, normalizeIgnoreRules } from '../src/title-rules.js';
import { loadIgnoreRules, saveIgnoreRules } from '../desktop/ignore-rules.js';

test('网站与忽略名称规范化，非法域名、过量设置和无效名称被拒绝', () => {
  assert.equal(normalizeWebsite(' Forum.Example.COM. '), 'forum.example.com');
  assert.equal(normalizeWebsite('书籍.example'), new URL('https://书籍.example').hostname);
  assert.deepEqual(normalizeIgnoredNamesByHost({ ' SITE.EXAMPLE ': [' ＸＸＸＸ ', 'xxxx', '板块名称'], 'empty.example': [] }), { 'site.example': ['XXXX', '板块名称'] });
  for (const host of ['', 'https://example.com', 'example.com/path', 'user@example.com', 'example.com:443', '[::1]:443', 'example.com?x', '__proto__', 'bad host']) {
    assert.throws(() => normalizeWebsite(host), TypeError, host);
  }
  for (const rules of [undefined, null, [], new Date(), new Map(), { 'example.com': 'xxxx' }, { 'example.com': [''] }, { 'example.com': [123] },
    { 'example.com': ['a\nb'] }, { 'example.com': ['a'.repeat(129)] }, { 'example.com': ['---'] },
    { 'example.com': Array(51).fill('xxxx') }, { 'EXAMPLE.com': ['a'], 'example.com': ['b'] },
    Object.fromEntries(Array.from({ length: 5001 }, (_, id) => [`s${id}.example`, ['x']]))]) {
    assert.throws(() => normalizeIgnoredNamesByHost(rules), TypeError);
  }
});

const rule = { name: '阅读站', domains: ['a.example', 'new.example'], ignoredNames: ['xxxx', '板块名称'] };

test('命名规则共用忽略词，规范化多个域名和词，跨规则重复域名被拒绝', () => {
  const input = [{ name: ' 阅读站 ', domains: ['A.EXAMPLE.', 'new.example', 'a.example'], ignoredNames: [' ＸＸＸＸ ', 'xxxx', '板块名称'] }];
  const original = structuredClone(input);
  assert.deepEqual(normalizeIgnoreRules(input), [{ ...rule, ignoredNames: ['XXXX', '板块名称'] }]);
  assert.deepEqual(input, original);
  assert.deepEqual(normalizeIgnoreRules([]), []);
  assert.throws(() => normalizeIgnoreRules([rule, { ...rule, name: '其他站', domains: ['NEW.EXAMPLE'] }]), /new.example.*阅读站/);
  for (const rules of [null, {}, Array(101).fill(rule), [null], [{ ...rule, name: '' }], [{ ...rule, name: 'a\nb' }],
    [{ ...rule, name: 'a'.repeat(129) }], [{ ...rule, domains: [] }], [{ ...rule, domains: 'a.example' }],
    [{ ...rule, domains: Array(51).fill('a.example') }], [{ ...rule, domains: ['https://a.example'] }],
    [{ ...rule, ignoredNames: [] }], [{ ...rule, ignoredNames: ['---'] }], [{ ...rule, ignoredNames: Array(51).fill('x') }]]) {
    assert.throws(() => normalizeIgnoreRules(rules), TypeError);
  }
  const maximum = Array.from({ length: 100 }, (_, index) => ({ ...rule, domains: Array.from({ length: 50 }, (_, domain) => `s${index}-${domain}.example`) }));
  assert.equal(Object.keys(normalizeIgnoredNamesByHost(Object.fromEntries(normalizeIgnoreRules(maximum).flatMap(({ domains, ignoredNames }) => domains.map((host) => [host, ignoredNames]))))).length, 5000);
});

test('旧域名映射无损读取成命名规则，读取不会改写原文件', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'tabtidy-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'ignored-names.json');
  const legacy = JSON.stringify({ 'A.EXAMPLE': ['xxxx'], 'b.example': ['板块名称'] });
  await writeFile(path, legacy);
  assert.deepEqual(await loadIgnoreRules(path), [
    { name: 'a.example', domains: ['a.example'], ignoredNames: ['xxxx'] },
    { name: 'b.example', domains: ['b.example'], ignoredNames: ['板块名称'] },
  ]);
  assert.equal(await readFile(path, 'utf8'), legacy);
  await writeFile(path, '{}');
  assert.deepEqual(await loadIgnoreRules(path), []);
});

test('设置写入后可重新读取、改名、添加域名及删除规则，验证失败不覆盖原文件', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'tabtidy-rules-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'settings', 'ignored-names.json');
  assert.deepEqual(await loadIgnoreRules(path), []);
  const other = { name: '另一个站点', domains: ['b.example'], ignoredNames: ['其他忽略词'] };
  await saveIgnoreRules(path, [rule, other]);
  assert.deepEqual(await loadIgnoreRules(path), [rule, other]);
  const original = await readFile(path, 'utf8');
  await assert.rejects(saveIgnoreRules(path, undefined), TypeError);
  await assert.rejects(saveIgnoreRules(path, [{ ...rule, ignoredNames: [''] }]), TypeError);
  await assert.rejects(saveIgnoreRules(path, [rule, { ...other, domains: ['A.EXAMPLE'] }]), /已用于/);
  assert.equal(await readFile(path, 'utf8'), original);
  const changed = { ...rule, name: '阅读站新名称', domains: [...rule.domains, 'latest.example'] };
  await saveIgnoreRules(path, [changed, other]);
  assert.deepEqual(await loadIgnoreRules(path), [changed, other]);
  await saveIgnoreRules(path, [other]);
  assert.deepEqual(await loadIgnoreRules(path), [other]);
  await saveIgnoreRules(path, []);
  assert.deepEqual(await loadIgnoreRules(path), []);
  assert.deepEqual(await readdir(join(directory, 'settings')), ['ignored-names.json']);
  await writeFile(path, '{bad json');
  await assert.rejects(loadIgnoreRules(path), /设置无法读取/);
  assert.equal(await readFile(path, 'utf8'), '{bad json', '损坏设置应保留，不能自动重置');
  const blocked = join(directory, 'blocked');
  await mkdir(blocked);
  await writeFile(join(blocked, 'keep.txt'), 'keep');
  await assert.rejects(saveIgnoreRules(blocked, [rule]));
  assert.equal(await readFile(join(blocked, 'keep.txt'), 'utf8'), 'keep');
  assert.ok(!(await readdir(directory)).some((name) => name.endsWith('.tmp')));
});
