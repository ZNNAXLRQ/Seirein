/**
 * Hold a hotkey for N ms so push-to-talk can be tested without a human at the keyboard.
 * Uses the same koffi/user32 path as the poller.
 *
 * Usage: node tools/ptt-hold.mjs [combo] [holdMs]
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const koffi = require('koffi');

const VK = { ctrl: 0x11, alt: 0x12, shift: 0x10, win: 0x5b };
const KEYUP = 0x0002;

const combo = (process.argv[2] ?? 'Ctrl+Alt+T').split('+').map((part) => part.trim().toLowerCase());
const holdMs = Number(process.argv[3] ?? 5000);
const key = combo[combo.length - 1];

const user32 = koffi.load('user32.dll');
const keybdEvent = user32.func('keybd_event', 'void', ['uint8', 'uint8', 'uint32', 'uintptr_t']);

const mods = combo.slice(0, -1).map((name) => VK[name]).filter((vk) => vk !== undefined);
const trigger = key.length === 1 ? key.toUpperCase().charCodeAt(0) : VK[key];
if (trigger === undefined) {
  console.error(`unsupported key in "${process.argv[2]}"`);
  process.exit(2);
}

const press = (vk) => keybdEvent(vk, 0, 0, 0);
const release = (vk) => keybdEvent(vk, 0, KEYUP, 0);

for (const vk of mods) press(vk);
press(trigger);
console.log(`held ${combo.join('+')} for ${holdMs} ms`);

setTimeout(() => {
  release(trigger);
  for (const vk of [...mods].reverse()) release(vk);
  console.log('released');
}, holdMs);
