import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const cli = new URL('../cli.js', import.meta.url);
const example = new URL('../examples/tabs.json', import.meta.url);

test('命令行输出可解析的候选组，错误写入 stderr 并返回非零状态', () => {
  const run = (...args) => spawnSync(process.execPath, [cli.pathname, ...args], { encoding: 'utf8' });
  const success = run(example.pathname, 'natural', 'desc');
  assert.equal(success.status, 0, success.stderr);
  const groups = JSON.parse(success.stdout);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups[0].tabs.map((tab) => tab.id), ['novel-11', 'novel-10']);

  const invalidOption = run(example.pathname, 'dictionary');
  assert.equal(invalidOption.status, 1);
  assert.equal(invalidOption.stdout, '');
  assert.match(invalidOption.stderr, /sortBy/);

  const noFile = run();
  assert.equal(noFile.status, 1);
  assert.match(noFile.stderr, /Usage/);

  const directory = mkdtempSync(join(tmpdir(), 'tabtidy-test-'));
  try {
    const invalidFile = join(directory, 'invalid.json');
    writeFileSync(invalidFile, '{ invalid json');
    assert.equal(run(invalidFile).status, 1);
    assert.equal(run(join(directory, 'missing.json')).status, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
