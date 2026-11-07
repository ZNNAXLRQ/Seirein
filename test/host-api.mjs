/** Public module names captured before the functional decomposition, not from the new files. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const expected = JSON.parse(readFileSync(new URL('./fixtures/public-host-api.json', import.meta.url), 'utf8'));

for (const [file, names] of Object.entries(expected)) {
  test(`${file} preserves its pre-refactor public API`, async () => {
    const module = await import(new URL(`../src/host/${file}`, import.meta.url));
    assert.deepEqual(Object.keys(module).sort(), names);
  });
}
