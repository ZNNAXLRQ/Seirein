// One-off auditor: extract a file from an Electron .asar archive and report pattern hits.
// Windows shell / ripgrep cannot read inside app.asar; the Host's own file APIs can.
// Usage: node tools/asar-peek.mjs <archive> <entry> [pattern...]
import { readFileSync } from 'node:fs';

const [archive, entry, ...patterns] = process.argv.slice(2);
if (!archive || !entry) {
  console.error('usage: node tools/asar-peek.mjs <archive> <entry> [pattern...]');
  process.exit(2);
}

const buf = readFileSync(archive);
// Electron asar header: [u32=4][sizes...][u32 jsonLength][json][data...]
// The JSON begins at byte 16 and its length sits at byte 12.
const jsonLength = buf.readUInt32LE(12);
const header = JSON.parse(buf.subarray(16, 16 + jsonLength).toString('utf8'));
const dataStart = 16 + jsonLength;

let node = header;
for (const part of entry.split('/')) {
  if (!node || !node.files || !node.files[part]) {
    console.error(`entry not found: ${part} (in ${entry})`);
    process.exit(1);
  }
  node = node.files[part];
}
if (!node.offset) {
  console.error('entry has no data offset (directory?)');
  process.exit(1);
}

const size = Number(node.size);
const text = buf.subarray(dataStart + Number(node.offset), dataStart + Number(node.offset) + size).toString('utf8');
console.log(`# ${entry}: ${size} bytes, ${text.split('\n').length} lines`);

if (patterns.length === 0) process.exit(0);
const lines = text.split('\n');
for (const p of patterns) {
  const re = new RegExp(p);
  const hits = [];
  lines.forEach((line, index) => {
    if (re.test(line)) hits.push(`${index + 1}: ${line.trim().slice(0, 160)}`);
  });
  console.log(`\n=== ${p} : ${hits.length} hit(s) ===`);
  console.log(hits.slice(0, 12).join('\n'));
}
