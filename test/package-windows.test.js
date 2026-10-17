import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'tabtidy-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'node_modules/@electron/packager'), { recursive: true });
  await mkdir(join(root, 'dist'), { recursive: true });
  await copyFile(new URL('../scripts/package-windows.js', import.meta.url), join(root, 'scripts/package-windows.js'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'dist/keep.txt'), 'keep');
  await writeFile(join(root, 'dist/previous.zip'), 'archive');
  await writeFile(join(root, 'node_modules/@electron/packager/package.json'), '{"type":"module","exports":"./index.js"}');
  await writeFile(join(root, 'node_modules/@electron/packager/index.js'), `
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function packager(options) {
  await writeFile(join(options.dir, 'packager-called.txt'), 'called');
  const output = join(options.out, 'TabTidy-win32-x64');
  await assert.rejects(access(output), { code: 'ENOENT' }, '进入打包器之前必须清理旧产物目录');
  assert.equal(await readFile(join(options.out, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(await readFile(join(options.out, 'previous.zip'), 'utf8'), 'archive');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'new.txt'), 'new');
  return [output];
}`);
  return { root, output: join(root, 'dist/TabTidy-win32-x64'), run: () => spawnSync(process.execPath, [join(root, 'scripts/package-windows.js')], { encoding: 'utf8' }) };
}

test('打包开始前自动删除旧产物，反复生成不需手动清理，其他文件保留', async (t) => {
  const { root, output, run } = await fixture(t);
  for (let attempt = 0; attempt < 2; attempt++) {
    await mkdir(join(output, 'old-resources'), { recursive: true });
    await writeFile(join(output, 'old-resources/obsolete.txt'), 'old');
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(access(join(output, 'old-resources')), { code: 'ENOENT' });
    assert.equal(await readFile(join(output, 'new.txt'), 'utf8'), 'new');
    assert.equal(await readFile(join(root, 'dist/keep.txt'), 'utf8'), 'keep');
    assert.equal(await readFile(join(root, 'dist/previous.zip'), 'utf8'), 'archive');
  }
});

test('首次生成时旧产物不存在也可正常打包', async (t) => {
  const { output, run } = await fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(output, 'new.txt'), 'utf8'), 'new');
});

test('清理失败时给出占用或权限提示，保留阻挡文件且不进入打包', async (t) => {
  const { root, run } = await fixture(t);
  await rm(join(root, 'dist'), { recursive: true, force: true });
  await writeFile(join(root, 'dist'), 'keep');
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /无法清理旧的 Windows 产物目录.*关闭正在运行的 TabTidy/u);
  assert.equal(await readFile(join(root, 'dist'), 'utf8'), 'keep');
  await assert.rejects(access(join(root, 'packager-called.txt')), { code: 'ENOENT' });
});
