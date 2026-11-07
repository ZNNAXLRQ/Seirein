/** Functional folders must keep the plugin entry and runtime resources resolvable. */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const host = join(repo, 'src', 'host');

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    return entry.isDirectory() ? sources(file) : /\.(?:js|mjs)$/.test(file) ? [file] : [];
  });
}

test('the host root exposes one entry; implementations live in functional folders', () => {
  const files = readdirSync(host, { withFileTypes: true }).filter((entry) => entry.isFile());
  assert.deepEqual(files.map((entry) => entry.name), ['index.js']);
  const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  assert.equal(manifest.main, './src/host/index.js');
  assert.equal(manifest.exports['.'], './src/host/index.js');
  assert.ok(manifest.files.includes('src/host/**'), 'nested workers and display assets must ship');
});

test('all local imports and literal runtime resource URLs resolve after relocation', () => {
  for (const file of sources(host)) {
    const source = readFileSync(file, 'utf8');
    const references = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bnew URL\s*\(\s*)(['"])(\.\.?\/[^'"\r\n]+)\1/g;
    for (const match of source.matchAll(references)) {
      if (match[2].includes('${')) continue;
      const target = resolve(dirname(file), match[2].split(/[?#]/)[0]);
      assert.ok(existsSync(target), `${file}: missing ${match[2]}`);
      if (file !== join(host, 'index.js')) {
        assert.notEqual(target, join(host, 'index.js'), `${file}: feature modules must not import the host entry`);
      }
    }
  }
});

test('ASR, WPF and the standalone Spout application retain their executable resources', () => {
  for (const resource of [
    'hearing/asr-worker.js',
    'avatar/transparent.ps1',
    'platform/window-move.ps1',
    'subtitle/overlay.ps1',
    'avatar/spout-layer/main.js',
    'avatar/spout-layer/preload.js',
    'avatar/spout-layer/renderer.js',
    'avatar/spout-layer/stage.js',
    'avatar/spout-layer/index.html',
  ]) assert.ok(existsSync(join(host, resource)), `missing resource ${resource}`);
  const spout = JSON.parse(readFileSync(join(host, 'avatar/spout-layer/package.json'), 'utf8'));
  assert.equal(spout.type ?? 'commonjs', 'commonjs', 'moving Spout must preserve its CommonJS package boundary');
});
