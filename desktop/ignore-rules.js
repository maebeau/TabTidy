import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { normalizeIgnoreRules, normalizeIgnoredNamesByHost } from '../src/title-rules.js';

export async function loadIgnoreRules(path) {
  try {
    const stored = JSON.parse(await readFile(path, 'utf8'));
    const rules = Array.isArray(stored) ? stored : Object.entries(normalizeIgnoredNamesByHost(stored))
      .map(([host, ignoredNames]) => ({ name: host, domains: [host], ignoredNames }));
    return normalizeIgnoreRules(rules);
  }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error('忽略名称设置无法读取，请保留 ignored-names.json 文件并联系开发者。', { cause: error });
  }
}

export async function saveIgnoreRules(path, rules) {
  const normalized = normalizeIgnoreRules(rules);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(normalized, null, 2), { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  return normalized;
}
