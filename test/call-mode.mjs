/**
 * Call mode and address gate (phase 1a, pure logic).
 *
 *   1. No enabled assistant name: `enter()` is refused and the mode stays normal.
 *   2. With a name: enter -> call, exit -> normal; re-entry keeps the original `enteredAt`.
 *   3. Address detection: sentence-start name (also after 那个/诶/喂), name + pause, a later
 *      sentence in the same text, and case/full-width folding all hit; a mid-sentence mention
 *      does not.
 *   4. A missed address never exits call mode; a finished reply does not open an unaddressed
 *      window (there is no such state in this module).
 *   5. Duplicate names are rejected across assistant names and user self-names (both directions),
 *      and renaming never changes the speakerId.
 *   6. A speaker with no aliases gets its own stable 「说话人 N」 label; empty names do not merge
 *      identities.
 *   7. The module is independent: importing and querying it has no side effects and no network.
 *
 * Run: node --test test/call-mode.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createCallMode, createSpeakerRegistry, detectAddress } from '../src/host/hearing/interaction/callMode.js';

test('1. 无启用称呼：enter 被拒，mode 仍是 normal', () => {
  const call = createCallMode({ names: [], now: () => 1000 });
  const blocked = call.enter();

  assert.deepEqual(blocked, { ok: false, mode: 'normal', reason: 'no-address-name' });
  assert.equal(call.mode, 'normal');
  assert.deepEqual(call.status(), { mode: 'normal', names: [], enteredAt: null });

  const blanks = createCallMode({ names: ['', '   ', null], now: 2000 });
  assert.deepEqual(blanks.enter(), { ok: false, mode: 'normal', reason: 'no-address-name' });
  assert.deepEqual(blanks.status(), { mode: 'normal', names: [], enteredAt: null });

  console.log(`[1] enter=${JSON.stringify(blocked)} status=${JSON.stringify(call.status())}`);
});

test('2. 有称呼 enter 进入 call，exit 回到 normal', () => {
  let current = 4100;
  const call = createCallMode({ names: ['小满'], now: () => current });

  assert.deepEqual(call.enter(), { ok: true, mode: 'call' });
  assert.equal(call.mode, 'call');
  assert.deepEqual(call.status(), { mode: 'call', names: ['小满'], enteredAt: 4100 });

  current = 9900;
  assert.deepEqual(call.enter(), { ok: true, mode: 'call' });
  assert.equal(call.status().enteredAt, 4100, '重复 enter 不重置进入时间');

  assert.deepEqual(call.exit(), { mode: 'normal' });
  assert.equal(call.mode, 'normal');
  assert.deepEqual(call.status(), { mode: 'normal', names: ['小满'], enteredAt: null });

  console.log(`[2] enteredAt=4100 afterReenter=4100 exit=${JSON.stringify(call.status())}`);
});

test('3. 句首称呼命中、句中提及不算、称呼+停顿命中、大小写与全半角折叠', () => {
  const names = ['小满'];
  const cases = [
    ['那个小满，你在吗', true, '小满', 2],
    ['诶，小满在吗', true, '小满', 2],
    ['喂小满？', true, '小满', 1],
    ['小满，在吗', true, '小满', 0],
    ['小满。在吗', true, '小满', 0],
    ['小满\n在吗', true, '小满', 0],
    ['今天下雨。小满，在吗', true, '小满', 5],
    ['今天和小满说了', false, undefined, undefined],
    ['今天和小满，说了', false, undefined, undefined],
  ];

  for (const [text, addressed, name, index] of cases) {
    const result = detectAddress(text, names);
    assert.equal(result.addressed, addressed, text);
    if (addressed) {
      assert.equal(result.name, name, text);
      assert.equal(result.index, index, text);
    }
  }

  assert.deepEqual(detectAddress('今天和小满说了', names), {
    addressed: false,
    reason: 'name-not-at-sentence-start',
  });
  assert.deepEqual(detectAddress('今天天气不错', names), {
    addressed: false,
    reason: 'name-not-present',
  });
  assert.deepEqual(detectAddress('', names), { addressed: false, reason: 'empty-text' });
  assert.deepEqual(detectAddress('小满，在吗', []), {
    addressed: false,
    reason: 'no-address-name',
  });

  // 大小写 + 全角/半角：名字与文本哪一侧是全角都能命中。
  assert.deepEqual(detectAddress('ＳＥＩ，在吗', ['Sei']), {
    addressed: true,
    name: 'Sei',
    index: 0,
  });
  assert.deepEqual(detectAddress('sei，在吗', ['ＳＥＩ']), {
    addressed: true,
    name: 'ＳＥＩ',
    index: 0,
  });

  // 多个称呼同时启用时取更长的那个，避免把「小满老师」读成「小满」。
  assert.deepEqual(detectAddress('小满老师，早', ['小满', '小满老师']), {
    addressed: true,
    name: '小满老师',
    index: 0,
  });

  console.log('[3] 那个/诶/喂 hit; mid-sentence miss; pause hit; full-width/case folded; longest-name wins');
});

test('4. 未见称呼不退出 call，也不会因刚回答过而打开免称呼窗口', () => {
  const call = createCallMode({ names: ['小满'], now: () => 5000 });
  call.enter();

  for (const text of ['我们先打一局', '刚才我说了什么', '等我一下']) {
    assert.equal(detectAddress(text, ['小满']).addressed, false, text);
    assert.equal(call.mode, 'call', `未寻址不应退出 call: ${text}`);
  }
  assert.equal(call.status().enteredAt, 5000, '未寻址不改变进入时间');

  // 模块没有任何“刚回答过”状态，所以下一句仍必须带称呼；只有显式 exit 才回 normal。
  assert.equal(detectAddress('那我继续了', ['小满']).addressed, false);
  assert.equal(call.mode, 'call');
  assert.deepEqual(call.exit(), { mode: 'normal' });
  assert.equal(call.mode, 'normal');

  console.log('[4] three misses keep mode=call; explicit exit -> normal');
});

test('5. 查重跨助手称呼与用户自称生效；改名不改 speakerId', () => {
  const registry = createSpeakerRegistry({ now: () => 7000, assistantNames: ['小满'] });
  const first = registry.addSpeaker({ speakerId: 'spk-a', names: ['阿明'] });
  assert.equal(first.ok, true);
  assert.equal(first.speaker.speakerId, 'spk-a');
  assert.deepEqual(first.speaker.names, ['阿明']);

  const duplicateAssistant = registry.addSpeaker({ speakerId: 'spk-b', names: ['小满'] });
  assert.equal(duplicateAssistant.ok, false);
  assert.equal(duplicateAssistant.reason, 'duplicate-name');
  assert.equal(duplicateAssistant.conflict.kind, 'assistant');

  const duplicateUser = registry.addSpeaker({ speakerId: 'spk-c', names: ['阿明'] });
  assert.equal(duplicateUser.ok, false);
  assert.equal(duplicateUser.reason, 'duplicate-name');
  assert.equal(duplicateUser.conflict.kind, 'speaker');
  assert.equal(duplicateUser.conflict.speakerId, 'spk-a');

  assert.deepEqual(registry.findConflict('小满'), { kind: 'assistant', name: '小满' });
  const userConflict = registry.findConflict('阿明');
  assert.equal(userConflict.kind, 'speaker');
  assert.equal(userConflict.speakerId, 'spk-a');
  assert.equal(registry.findConflict('阿明', { exceptSpeakerId: 'spk-a' }), null);

  const renameToAssistantName = registry.rename('spk-a', ['小满']);
  assert.equal(renameToAssistantName.ok, false);
  assert.equal(renameToAssistantName.reason, 'duplicate-name');

  const renamed = registry.rename('spk-a', ['阿强']);
  assert.equal(renamed.ok, true);
  assert.equal(registry.get('spk-a').speakerId, 'spk-a');
  assert.deepEqual(registry.get('spk-a').names, ['阿强']);
  assert.equal(registry.defaultLabel('spk-a'), '阿强');

  // 全半角/大小写折叠也参与跨类查重。
  const latin = createSpeakerRegistry({ assistantNames: ['Sei'] });
  assert.equal(latin.addSpeaker({ speakerId: 'spk-l', names: ['ｓｅｉ'] }).reason, 'duplicate-name');

  // 反向：先有用户自称「阿强」，再把助手称呼改成「阿强」也要被拒。
  assert.equal(registry.setAssistantNames(['阿强']).ok, false);
  assert.equal(registry.setAssistantNames(['新名']).ok, true);
  assert.equal(registry.addSpeaker({ speakerId: 'spk-d', names: ['新名'] }).reason, 'duplicate-name');

  console.log('[5] duplicate=assistant/speaker rejected; rename keeps spk-a; cross-class both directions');
});

test('6. 默认显示「说话人 N」，空名字不等于共用身份', () => {
  const registry = createSpeakerRegistry({ now: 8000 });
  const unnamedA = registry.addSpeaker({ speakerId: 'spk-a', names: [] });
  const unnamedB = registry.addSpeaker({ speakerId: 'spk-b', names: ['', '   '] });
  const named = registry.addSpeaker({ speakerId: 'spk-c', names: ['小明', '明明'] });

  assert.equal(unnamedA.ok, true);
  assert.equal(unnamedB.ok, true);
  assert.deepEqual(unnamedA.speaker.names, []);
  assert.deepEqual(unnamedB.speaker.names, []);
  assert.equal(registry.defaultLabel('spk-a'), '说话人 1');
  assert.equal(registry.defaultLabel('spk-b'), '说话人 2');
  assert.equal(registry.defaultLabel('spk-c'), '小明');

  assert.notEqual(registry.get('spk-a').speakerId, registry.get('spk-b').speakerId);
  assert.equal(registry.list().length, 3);
  assert.equal(registry.get('missing'), null);
  assert.equal(registry.defaultLabel('missing'), null);

  // 改名（包括改回空名字）不改变身份；序号仍属于原来的 speakerId。
  assert.equal(registry.rename('spk-c', []).ok, true);
  assert.equal(registry.get('spk-c').speakerId, 'spk-c');
  assert.equal(registry.defaultLabel('spk-c'), '说话人 3');

  // 返回的是副本，外部改列表不会污染登记表。
  const listed = registry.list();
  listed[0].names.push('外部写入');
  assert.deepEqual(registry.get('spk-a').names, []);

  console.log('[6] labels=说话人 1/说话人 2/小明; rename -> 说话人 3; empty names keep distinct ids');
});

test('7. 模块独立、无副作用、无网络依赖', () => {
  const call = createCallMode({ names: ['小满'] });
  assert.equal(call.mode, 'normal', '创建实例不自动进入 call');

  const registry = createSpeakerRegistry();
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.findConflict('小满'), null);

  // 检测呼叫本身不改变任何状态，也不修改传入的 names 数组。
  const names = ['小满'];
  const before = [...names];
  const hit = detectAddress('小满，在吗', names);
  assert.equal(hit.addressed, true);
  assert.deepEqual(names, before);
  assert.equal(call.mode, 'normal');

  console.log('[7] initial mode=normal; empty registry; detectAddress is read-only');
});

test('8. 英文称呼要求完整词边界；中文称呼保持句首命中', () => {
  const check = (label, text, names) => {
    const result = detectAddress(text, names);
    console.log(`[8.${label}] ${JSON.stringify(text)} names=${JSON.stringify(names)} -> ${JSON.stringify(result)}`);
    return result;
  };

  // 1) 反例：Sei 不再命中 Seize 的前缀。
  assert.deepEqual(check('1', 'Seize the day', ['Sei']), {
    addressed: false,
    reason: 'word-boundary',
  });
  // 2) 英文 + 标点/停顿命中。
  assert.deepEqual(check('2', 'Sei, 你在吗', ['Sei']), {
    addressed: true,
    name: 'Sei',
    index: 0,
  });
  // 3) 英文紧跟中文按设计仍允许（中文不是 ASCII 词字符）。
  assert.deepEqual(check('3', 'Sei你在吗', ['Sei']), {
    addressed: true,
    name: 'Sei',
    index: 0,
  });
  // 4) 中文称呼：标点后命中；被后缀延长成另一个名字则不命中。
  assert.deepEqual(check('4a', '小满，帮我看看', ['小满']), {
    addressed: true,
    name: '小满',
    index: 0,
  });
  assert.equal(check('4b', '小满子', ['小满']).addressed, false);
  assert.equal(check('4c', '小满子，早', ['小满']).addressed, false);
  assert.equal(check('4d', '小满在吗', ['小满']).addressed, true);
  // 更长名字优先于后缀判断：启用「小满子」时它才是称呼。
  assert.deepEqual(check('4e', '小满子，早', ['小满', '小满子']), {
    addressed: true,
    name: '小满子',
    index: 0,
  });
  // 5) 句首单独出现。
  assert.deepEqual(check('5', 'Sei', ['Sei']), {
    addressed: true,
    name: 'Sei',
    index: 0,
  });
  // 6) 大小写/全半角回归；字母、数字、下划线都不是边界。
  assert.deepEqual(check('6a', 'ＳＥＩ，在吗', ['Sei']), {
    addressed: true,
    name: 'Sei',
    index: 0,
  });
  assert.deepEqual(check('6b', 'sei，在吗', ['ＳＥＩ']), {
    addressed: true,
    name: 'ＳＥＩ',
    index: 0,
  });
  assert.deepEqual(check('6c', '那个Sei，在吗', ['Sei']), {
    addressed: true,
    name: 'Sei',
    index: 2,
  });
  for (const text of ['Sei2', 'Sei_x', 'SEIZE', 'ＳＥＩＺＥ']) {
    assert.equal(check('6d', text, ['Sei']).addressed, false, text);
  }
  // 7) 回归：node --test test/call-mode.mjs 与 node test/smoke.mjs（见运行记录）。
});
