import { readFile } from 'node:fs/promises';
import { analyzeTabs } from './src/core.js';

try {
  const [file, sortBy = 'natural', direction = 'desc', ...extra] = process.argv.slice(2);
  if (!file || extra.length) {
    throw new Error('Usage: node cli.js <tabs.json> [natural|time] [asc|desc]');
  }
  const tabs = JSON.parse(await readFile(file, 'utf8'));
  console.log(JSON.stringify(analyzeTabs(tabs, { sortBy, direction }), null, 2));
} catch (error) {
  console.error(`TabTidy: ${error.message}`);
  process.exitCode = 1;
}
