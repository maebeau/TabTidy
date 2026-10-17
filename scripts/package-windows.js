import { packager } from '@electron/packager';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, 'dist');
const output = join(out, 'TabTidy-win32-x64');
console.log(`正在清理旧的 Windows 产物目录：${output}`);
try {
  await rm(output, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
} catch (error) {
  throw new Error(`无法清理旧的 Windows 产物目录：${output}。请先关闭正在运行的 TabTidy，并检查文件占用或目录权限后重试。`, { cause: error });
}
const paths = await packager({
  dir: root, name: 'TabTidy', platform: 'win32', arch: 'x64', out, overwrite: true,
  asar: true, extraResource: [`${root}browser-extension`],
  ignore: [/^\/(dist|test|scripts|\.scratch|\.git|artifacts|browser-extension)(\/|$)/, /\/\.DS_Store$/],
  download: {
    cacheRoot: process.env.ELECTRON_CACHE,
    mirrorOptions: { mirror: 'https://npmmirror.com/mirrors/electron/', customDir: '{{ version }}' },
  },
});
console.log(`Windows 便携版已生成：${paths[0]}\n请将整个文件夹分发，不能单独移动 TabTidy.exe。`);
