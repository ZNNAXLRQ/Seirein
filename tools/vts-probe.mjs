/**
 * VTube Studio API probe: authenticate, read the model, list hotkeys, optionally fire one.
 *
 * Usage: node tools/vts-probe.mjs [--trigger]
 * The first run makes VTube Studio show an "allow plugin" dialog; click Allow there.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import WebSocket from 'ws';

const TOKEN_FILE = join(process.env.LOCALAPPDATA, 'dsh-assistant', 'vts-token.json');
const PLUGIN = { pluginName: 'DSH Companion', pluginDeveloper: 'local' };
const shouldTrigger = process.argv.includes('--trigger');

const ws = new WebSocket('ws://127.0.0.1:8001');
let seq = 0;
const pending = new Map();

ws.on('message', (raw) => {
  let message;
  try {
    message = JSON.parse(String(raw));
  } catch {
    return;
  }
  const waiter = pending.get(message.requestID);
  if (waiter) {
    pending.delete(message.requestID);
    waiter(message);
  }
});

function request(messageType, data = {}, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const requestID = `probe-${++seq}`;
    const timer = setTimeout(() => {
      pending.delete(requestID);
      reject(new Error(`${messageType} timed out (did you click Allow in VTube Studio?)`));
    }, timeoutMs);
    pending.set(requestID, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    ws.send(JSON.stringify({ apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0', requestID, messageType, data }));
  });
}

await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});
console.log('connected to ws://127.0.0.1:8001');

// 1) Reuse a saved token when possible; otherwise ask VTS for one (user must allow).
let token = '';
try {
  token = JSON.parse(await readFile(TOKEN_FILE, 'utf8')).authenticationToken ?? '';
} catch {
  token = '';
}

if (token.length === 0) {
  console.log('requesting an authentication token (VTS should ask you to allow the plugin)...');
  const response = await request('AuthenticationTokenRequest', PLUGIN);
  token = response.data?.authenticationToken ?? '';
  if (token.length === 0) {
    console.error('no token received:', JSON.stringify(response.data));
    process.exit(1);
  }
  await writeFile(TOKEN_FILE, JSON.stringify({ authenticationToken: token }, null, 2), 'utf8');
  console.log('token saved to', TOKEN_FILE);
}

const auth = await request('AuthenticationRequest', { ...PLUGIN, authenticationToken: token });
console.log('auth:', auth.data?.authenticated === true ? 'OK' : JSON.stringify(auth.data));

const current = await request('CurrentModelRequest', {});
console.log('model:', JSON.stringify(current.data));

const hotkeys = await request('HotkeysInCurrentModelRequest', {});
console.log('hotkeys:', JSON.stringify(hotkeys.data?.availableHotkeys ?? []));

const expressions = await request('ExpressionStateRequest', { details: true });
console.log('expressions:', JSON.stringify((expressions.data?.expressions ?? []).map((e) => e.name)));

if (shouldTrigger) {
  const first = (hotkeys.data?.availableHotkeys ?? [])[0];
  if (!first) {
    console.log('no hotkey to trigger; try an expression instead');
  } else {
    const fired = await request('HotkeyTriggerRequest', { hotkeyID: first.hotkeyID });
    console.log('triggered:', first.name, '->', JSON.stringify(fired.data));
  }
}

ws.close();
