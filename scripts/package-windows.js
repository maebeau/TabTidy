import { packager } from '@electron/packager';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const paths = await packager({
  dir: root, name: 'TabTidy', platform: 'win32', arch: 'x64', out: `${root}dist`, overwrite: true,
  asar: true, extraResource: [`${root}browser-extension`],
  ignore: [/^\/(dist|test|scripts|\.scratch|\.git|artifacts|browser-extension)(\/|$)/, /\/\.DS_Store$/],
  download: {
    cacheRoot: process.env.ELECTRON_CACHE,
    mirrorOptions: { mirror: 'https://npmmirror.com/mirrors/electron/', customDir: '{{ version }}' },
  },
});
console.log(`Windows 便携版已生成：${paths[0]}\n请将整个文件夹分发，不能单独移动 TabTidy.exe。`);
