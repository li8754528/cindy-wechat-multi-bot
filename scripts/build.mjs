import { build } from 'esbuild';
import { mkdir, copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
await mkdir('wechat-companion/node', { recursive: true });
const results = await Promise.all([
  build({ entryPoints: ['src/main.mjs'], bundle: true, platform: 'browser', format: 'iife', target: 'chrome130', outfile: 'wechat-companion/main.js' }),
  build({ entryPoints: ['src/worker-entry.cjs'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', metafile: true, outfile: 'wechat-companion/node/worker.cjs' }),
  ...['settings.html', 'settings.js', 'settings.css'].map(name => copyFile(`src/${name}`, `wechat-companion/${name}`)),
  copyFile('LICENSE', 'wechat-companion/LICENSE'),
]);
const packages = new Set(Object.keys(results[1].metafile.inputs).filter(path => path.startsWith('node_modules/')).map(path => {
  const parts = path.split('/'); return parts[1].startsWith('@') ? parts.slice(0, 3).join('/') : parts.slice(0, 2).join('/');
}));
const notices = ['# Bundled third-party licenses'];
for (const dir of [...packages].sort()) {
  const pkg = JSON.parse(await readFile(`${dir}/package.json`, 'utf8'));
  const files = (await readdir(dir)).filter(name => /^(licen[sc]e|copying)(\.|$)/i.test(name));
  if (!files.length) throw new Error(`Missing bundled license: ${pkg.name}`);
  notices.push(`\n## ${pkg.name} ${pkg.version}`);
  for (const name of files) notices.push(await readFile(`${dir}/${name}`, 'utf8'));
}
await writeFile('wechat-companion/THIRD_PARTY_LICENSES.md', notices.join('\n').trimEnd() + '\n');
