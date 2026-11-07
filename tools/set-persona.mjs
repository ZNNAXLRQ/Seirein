/**
 * One-off repair: write the persona through the settings API using explicit UTF-8.
 * PowerShell's Invoke-RestMethod mangles non-ASCII JSON bodies, which is how the profile
 * got filled with question marks; Node's fetch does not.
 *
 * Usage: node tools/set-persona.mjs
 */
const endpoint = process.env.ASSISTANT_URL ?? 'http://127.0.0.1:64016';

const agent = ['# 人设', '- 语气简洁直接，先给结论再解释。', '- 不确定的事先说不确定，不编造。'].join('\n');

const response = await fetch(`${endpoint}/assistant/action`, {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ action: 'persona.set', which: 'agent', text: agent }),
});
console.log('set:', await response.text());

const check = await fetch(`${endpoint}/assistant/action`, {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ action: 'persona.get' }),
});
const payload = await check.json();
console.log('agent:', JSON.stringify(payload.agent));
