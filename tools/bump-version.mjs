/** Bump the version in package.json and both version constants (UTF-8 safe). */
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: node tools/bump-version.mjs 0.37.2');
  process.exit(2);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
pkg.version = version;
writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

for (const [file, pattern] of [
  ['src/host/index.js', /const PLUGIN_VERSION = '[^']+';/],
  ['client.js', /const CLIENT_VERSION = '[^']+';/],
]) {
  const text = readFileSync(file, 'utf8');
  const constant = pattern.source.includes('PLUGIN') ? 'PLUGIN_VERSION' : 'CLIENT_VERSION';
  const next = text.replace(pattern, `const ${constant} = '${version}';`);
  if (next === text) throw new Error(`version constant not found in ${file}`);
  writeFileSync(file, next, 'utf8');
  console.log(`${file} -> ${version}`);
}
console.log('package.json ->', version);
