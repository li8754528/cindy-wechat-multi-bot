import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync('wechat-companion/ghost.json', 'utf8'));
for (const path of [manifest.entry, manifest.node.entry, 'settings.js']) {
  const result = spawnSync(process.execPath, ['--check', `wechat-companion/${path}`], { encoding: 'utf8' });
  if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(1); }
}
console.log('Generated browser/Node entrypoints have valid syntax.');
