/**
 * Tool-output schema regression: `assistant_vision` returned `lastShot`, but its output schema
 * did not declare it, so the host rejected status results with
 * `"value.lastShot" is not a declared property (additionalProperties: false)`.
 * This mounts the plugin against a fake context, takes the status branch, and validates the
 * returned object against the tool's own output schema with a minimal subset validator.
 *
 * Run: node --test test/tool-schema-vision.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../src/host/index.js';
import { cleanupRoot } from './helpers/cleanup.mjs';

const TYPE_CHECKS = {
  object: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  array: (value) => Array.isArray(value),
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === 'boolean',
  null: (value) => value === null,
};

/** Validate one value against the tool-output schema subset (type/oneOf/object/array/enum/const). */
function validate(schema, value, path = 'value') {
  if (Object.hasOwn(schema, 'oneOf')) {
    const matches = schema.oneOf.filter((candidate) => {
      try {
        validate(candidate, value, path);
        return true;
      } catch {
        return false;
      }
    });
    assert.equal(matches.length, 1, `${path} must match exactly one oneOf branch`);
    return;
  }
  if (Object.hasOwn(schema, 'type')) {
    assert.ok(TYPE_CHECKS[schema.type](value), `${path} must be of type ${schema.type}`);
  }
  if (Object.hasOwn(schema, 'enum')) assert.ok(schema.enum.includes(value), `${path} is not an enum member`);
  if (Object.hasOwn(schema, 'const')) assert.equal(value, schema.const, `${path} must equal const`);
  if (schema.type === 'object') {
    assert.ok(value !== null && typeof value === 'object', `${path} must be an object`);
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `${path}.${key} is required`);
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validate(child, value[key], `${path}.${key}`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        assert.ok(Object.hasOwn(properties, key), `"${path}.${key}" is not a declared property`);
      }
    }
  }
  if (schema.type === 'array') {
    for (const [index, item] of value.entries()) validate(schema.items ?? {}, item, `${path}[${index}]`);
  }
}

test('assistant_vision status output matches its declared schema', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tool-schema-vision-'));
  // Keep the effect disposers and run them before rm: the fake context's discarded disposers
  // let the stores hold Windows locks on the temp root.
  const disposers = [];
  t.after(() => cleanupRoot(root, disposers));

  const tools = new Map();
  const ctx = {
    effect: (fn) => {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
  };
  apply(ctx, { root, defaultDomain: 'chat', enabled: true });

  const tool = tools.get('assistant_vision');
  assert.ok(tool !== undefined, 'assistant_vision is registered');
  const schema = tool.output.schema;
  assert.ok(Object.hasOwn(schema.properties, 'lastShot'), 'the output schema declares lastShot');
  for (const field of ['source', 'capturing', 'lastCaptureAt', 'obsRunning']) {
    assert.ok(Object.hasOwn(schema.properties, field), `the output schema declares ${field}`);
  }

  const value = await tool.execute({ action: 'status' }, {});
  assert.equal(value.ok, true, 'status succeeds');
  assert.ok(Object.hasOwn(value, 'lastShot'), 'status returns lastShot');
  assert.ok(value.source === 'desktop' || value.source === 'obs', 'status names the view source');
  assert.equal(value.capturing, false, 'no continuous capture at mount');
  assert.equal(value.lastCaptureAt, null);
  validate(schema, value);

  // No capture yet: null must satisfy the same declaration.
  validate(schema.properties.lastShot, null, 'value.lastShot');
  // After a capture: the recorded file/time/source shape must also satisfy it.
  validate(
    schema.properties.lastShot,
    { file: 'shot.png', source: 'watch', engine: 'ffmpeg', ts: Date.now(), width: 1280, height: 720 },
    'value.lastShot',
  );
  validate(
    schema.properties.lastShot,
    { file: 'scene.png', source: 'scene', scene: 'Chat', ts: Date.now(), width: 1280, height: 720 },
    'value.lastShot',
  );
});
