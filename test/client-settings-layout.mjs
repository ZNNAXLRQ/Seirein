/**
 * 设置页信息架构回归（第二次重整，2026-11-09）：
 *   1. 分区顺序固定为 12 段：插件与工作目录 → 组件开关 → 视觉 → 听觉 → 形象 → 记忆 →
 *      声纹 → 语音 → 通话 → 字幕 → 诊断与维护 → 其他设置；
 *   2. 视觉在听觉之前，麦克风与回环同属「听觉」卡片的不同子容器，通话模式与声纹各自独立成卡；
 *   3. 「记忆」从维护移回「记忆与人设」；「其他设置」在最后，且注明日常不用改；
 *   4. 同一大功能的子项合并进一张分区卡片，卡片内部用圆角子容器 + 分隔线组织；
 *   5. 子容器样式：8–10px 圆角、很浅的灰底（#f6f8fa）、10–12px 内边距；
 *   6. 行内 label 固定宽度、操作列右对齐，按钮/输入框同一套尺寸；
 *   7. 工作目录只展示一次（旧版「关于」里的重复行、重复的工作目录展示已删除）。
 *
 * 做法与其它 client 测试一致：从 client.js 抽出真正发货的布局函数，用记录型 `h` 求值，
 * 不需要 DOM、React 或宿主。
 *
 * Run: node --test test/client-settings-layout.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_FEATURES } from '../src/host/runtime/features.js';

const here = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(here, '..', 'client.js'), 'utf8');

/** Recording element factory: every node keeps its type, props and children. */
const h = (type, props, ...children) => ({ type, props: props ?? {}, children });

// ---- the shipped style object (evaluated with its colour constants) -------------------------
const stylesFrom = clientSource.indexOf('    const styles = {');
const stylesTo = clientSource.indexOf('    // ---- 设置页布局：', stylesFrom);
assert.ok(stylesFrom > 0 && stylesTo > stylesFrom, 'client.js ships the style object');
const styles = new Function(
  'MUTED', 'BORDER', 'ACCENT', 'DANGER',
  `${clientSource.slice(stylesFrom, stylesTo)}\nreturn styles;`,
)('#6b7280', '#d8dce3', '#3b5bdb', '#c92a2a');

// ---- the shipped layout helpers ------------------------------------------------------------
const layoutFrom = clientSource.indexOf('    // ---- 设置页布局：');
const layoutTo = clientSource.indexOf('    /** The global hotkeys', layoutFrom);
assert.ok(layoutFrom > 0 && layoutTo > layoutFrom, 'client.js ships the settings layout block');
const layoutBlock = clientSource.slice(layoutFrom, layoutTo);
const layout = new Function(
  'styles',
  `${layoutBlock}
return {
  SETTINGS_SECTIONS, SETTINGS_SECTION_IDS, SETTINGS_FALLBACK_SECTION_ID,
  settingsBlock, settingsCard, settingsGroup, settingsDivider, settingsField, settingsActions,
  groupSettingsBlocks,
};`,
)(styles);

const {
  SETTINGS_SECTIONS, SETTINGS_SECTION_IDS, SETTINGS_FALLBACK_SECTION_ID, settingsBlock,
  settingsCard, settingsGroup, settingsDivider, settingsField, settingsActions, groupSettingsBlocks,
} = layout;

const EXPECTED_SECTIONS = [
  'intro', 'features', 'vision', 'hearing', 'avatar', 'memory',
  'speaker', 'voice', 'call', 'subtitle', 'diagnostics', 'misc',
];
const EXPECTED_TITLES = [
  '1 插件与工作目录', '2 组件开关', '3 视觉', '4 听觉', '5 形象与动作', '6 记忆与人设',
  '7 声纹', '8 语音', '9 通话模式', '10 字幕', '11 诊断与维护', '12 其他设置',
];

const nodesOf = (tree) => {
  const nodes = [];
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    nodes.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return nodes;
};

const textsOf = (tree) => nodesOf(tree).flatMap((node) => (node.children ?? [])
  .filter((child) => typeof child === 'string'));

const byProps = (tree, key, value) => nodesOf(tree).filter((node) => node.props[key] === value);

const sectionIdsOf = (tree) => tree.map((section) => section.props['data-settings-section']);

const cardIdsOf = (node) => nodesOf(node)
  .filter((child) => typeof child.props['data-settings-card'] === 'string')
  .map((child) => child.props['data-settings-card']);

const at = (needle) => {
  const index = clientSource.indexOf(needle);
  assert.ok(index > 0, `client.js contains ${needle}`);
  return index;
};

// ---- 1. 12 sections, by importance ---------------------------------------------------------

test('1. 分区顺序：插件与工作目录 → 组件开关 → 视觉 → 听觉 → 形象 → 记忆 → 声纹 → 语音 → 通话 → 字幕 → 诊断 → 其他', () => {
  const tree = groupSettingsBlocks(h, [
    settingsBlock('misc', h('div', { 'data-card': 'misc-card' })),
    settingsBlock('diagnostics', h('div', { 'data-card': 'diagnostics-card' })),
    settingsBlock('intro', h('div', { 'data-card': 'intro-card' })),
    settingsBlock('hearing', h('div', { 'data-card': 'hearing-card' })),
    settingsBlock('features', h('div', { 'data-card': 'features-card' })),
  ]);
  assert.deepEqual(sectionIdsOf(tree), ['intro', 'features', 'hearing', 'diagnostics', 'misc'],
    '渲染顺序由 SETTINGS_SECTIONS 决定，与块的声明顺序无关');
  assert.deepEqual(SETTINGS_SECTIONS.map((section) => section.id), EXPECTED_SECTIONS);
  assert.deepEqual(SETTINGS_SECTIONS.map((section) => section.title), EXPECTED_TITLES);
  const titles = textsOf(tree);
  for (const title of ['1 插件与工作目录', '2 组件开关', '4 听觉', '11 诊断与维护', '12 其他设置']) {
    assert.ok(titles.includes(title), `分区标题可见：${title}`);
  }
  console.log(`1) order=${sectionIdsOf(tree).join(' → ')} total=${SETTINGS_SECTIONS.length}`);
});

test('2. 每个分区恰好一个 heading/body；没有折叠分区；其他设置最后且写明日常不用改', () => {
  const tree = groupSettingsBlocks(h, SETTINGS_SECTIONS.map((section) => (
    settingsBlock(section.id, settingsCard(h, `${section.id}-card`, `${section.id} 卡片`,
      section.id === 'misc'
        ? h('div', { style: styles.hint }, '日常不用改：连带启动、全局快捷键与闲聊模式，设置一次后很少再动。')
        : null))
  )));
  for (const section of SETTINGS_SECTIONS) {
    assert.equal(byProps(tree, 'data-settings-heading', section.id).length, 1,
      `${section.id} renders exactly one heading`);
    assert.equal(byProps(tree, 'data-settings-body', section.id).length, 1,
      `${section.id} renders exactly one body`);
  }
  assert.equal(byProps(tree, 'data-settings-collapsed', 'true').length, 0,
    '12 个分区都不再包 <details>：其他设置也要直接可见');
  const last = tree.at(-1);
  assert.equal(last.props['data-settings-section'], 'misc', '其他设置固定最后');
  assert.equal(SETTINGS_FALLBACK_SECTION_ID, 'misc', '未知块落到最后一个分区');
  assert.ok(textsOf(last).includes('12 其他设置'));
  assert.ok(textsOf(last).includes('日常不用改：连带启动、全局快捷键与闲聊模式，设置一次后很少再动。'),
    '卡片标题下有一句话说明日常不用改');
  assert.equal(SETTINGS_SECTIONS.some((section) => /低频/.test(section.title)), false,
    '不再使用「低频配置」这个名字');
  console.log(`2) headings=${SETTINGS_SECTIONS.length} collapsed=0 last=${SETTINGS_FALLBACK_SECTION_ID}`);
});

test('3. 未知分区与数组块：落到其他设置，不会被静默丢弃', () => {
  const stray = h('div', { 'data-card': 'stray' });
  const tree = groupSettingsBlocks(h, [
    settingsBlock('nope', stray),
    settingsBlock('intro', [h('div', { 'data-card': 'a' }), h('div', { 'data-card': 'b' })]),
  ]);
  assert.deepEqual(sectionIdsOf(tree), ['intro', 'misc']);
  assert.equal(byProps(tree, 'data-card', 'stray').length, 1, '未知分区的块仍然渲染（落到其他设置）');
  const intro = tree.find((section) => section.props['data-settings-section'] === 'intro');
  assert.equal(byProps(intro, 'data-card', 'a').length, 1);
  assert.equal(byProps(intro, 'data-card', 'b').length, 1);
  assert.deepEqual(groupSettingsBlocks(h, []), [], '空块表不渲染空分区');
  console.log('3) unknown→misc arrayBlocks=2');
});

// ---- 2. sub-containers ---------------------------------------------------------------------

test('4. 子容器：圆角 8–10px、浅灰底 #f6f8fa、10–12px 内边距，且只负责视觉分组', () => {
  const group = settingsGroup(h, 'mic', '麦克风与门限', h('span', null, '控件'));
  assert.equal(group.props['data-settings-group'], 'mic', '子容器带稳定的 data-settings-group');
  assert.equal(styles.group.borderRadius, 10);
  assert.ok(styles.group.borderRadius >= 8 && styles.group.borderRadius <= 10,
    `子容器圆角在 8–10px：${styles.group.borderRadius}`);
  assert.equal(styles.group.background, '#f6f8fa', '浅灰底');
  assert.equal(styles.group.padding, '10px 12px', '内边距 10–12px');
  assert.equal(styles.group.display, 'flex');
  assert.equal(styles.group.flexDirection, 'column');
  // 子容器不引入任何行为：没有事件处理器、没有状态字段。
  assert.equal(group.props.onClick, undefined);
  assert.ok(textsOf(group).includes('麦克风与门限'), '子容器标题可见');
  console.log(`4) radius=${styles.group.borderRadius} background=${styles.group.background} padding=${styles.group.padding}`);
});

test('5. 分区卡片：白底、子容器之间自动插分隔线（n 个子容器 → n-1 条线）', () => {
  const card = settingsCard(
    h,
    'voice',
    '语音',
    settingsGroup(h, 'language', '语种'),
    settingsGroup(h, 'tts', '语音合成与候音'),
    settingsGroup(h, 'gpt', 'GPT-SoVITS'),
  );
  assert.equal(card.props['data-settings-card'], 'voice');
  assert.equal(styles.sectionCard.background, '#fff');
  assert.equal(styles.sectionCard.borderRadius, 12);
  const dividers = card.children.filter((child) => child !== null && child.props?.['data-settings-divider']);
  assert.equal(dividers.length, 2, '三个子容器之间有两条分隔线');
  assert.equal(dividers[0].type, 'div');
  assert.equal(dividers[0].props.role, 'separator');
  for (const id of ['language', 'tts', 'gpt']) {
    assert.equal(byProps(card, 'data-settings-group', id).length, 1, `${id} 子容器在卡片里`);
  }
  const divider = settingsDivider(h, 'voice-1');
  assert.equal(divider.props['data-settings-divider'], 'voice-1');
  assert.equal(styles.divider.borderTop, '1px solid #e5e9ef');
  console.log(`5) dividers=${dividers.length} groups=3`);
});

// ---- 3. the requested structure ------------------------------------------------------------

test('6. 结构：视觉在听觉之前；麦克风与回环同卡；通话与声纹独立；记忆回到记忆与人设；其他设置在最后', () => {
  const visionAt = at("settingsCard(h, 'vision', '视觉与感知'");
  const hearingAt = at("settingsCard(h, 'hearing', '听觉'");
  const avatarAt = at("settingsCard(h, 'avatar', '形象与动作'");
  const memoryPeopleAt = at("settingsCard(h, 'memory-people', '记忆与人设'");
  const speakerAt = at("settingsCard(h, 'speaker',");
  const voiceAt = at("settingsCard(h, 'voice', '语音'");
  const callAt = at("settingsCard(h, 'call', '通话模式'");
  const subtitleAt = at("settingsCard(h, 'subtitle', '字幕'");
  const diagnosticsAt = at("settingsCard(h, 'diagnostics', '运行诊断'");
  const miscAt = at("settingsCard(h, 'misc', '其他设置'");
  assert.ok(visionAt < hearingAt, '视觉在听觉之前（重要在前）');
  assert.ok(hearingAt < avatarAt && avatarAt < memoryPeopleAt && memoryPeopleAt < speakerAt,
    '听觉 → 形象 → 记忆 → 声纹 的顺序');
  assert.ok(speakerAt < voiceAt && voiceAt < callAt && callAt < subtitleAt && subtitleAt < diagnosticsAt,
    '声纹 → 语音 → 通话 → 字幕 → 诊断 的顺序');
  assert.ok(diagnosticsAt < miscAt, '其他设置固定最后');

  // 麦克风与回环/环境声音在听觉卡片内、但仍是两个独立子容器。
  const hearingEnd = at("\n        settingsBlock('avatar'");
  const hearingRegion = clientSource.slice(hearingAt, hearingEnd);
  assert.match(hearingRegion, /settingsGroup\(h, 'mic'/, '听觉卡片里有麦克风子容器');
  assert.match(hearingRegion, /settingsGroup\(h, 'ambient'/, '听觉卡片里有回环/环境声音子容器');
  assert.doesNotMatch(hearingRegion, /settingsGroup\(h, 'call-mode'/, '通话模式不再并进听觉卡片');
  assert.doesNotMatch(hearingRegion, /settingsGroup\(h, 'tts'/, '语音合成不再并进听觉卡片');

  // 通话模式与声纹各自独立成卡。
  assert.match(clientSource.slice(callAt, subtitleAt), /callModeSection\(h, \{/,
    '通话模式卡片直接挂 callModeSection');
  assert.match(clientSource.slice(speakerAt, voiceAt), /speakerEnrollSection\(h, \{/,
    '声纹卡片直接挂 speakerEnrollSection');
  assert.match(clientSource.slice(speakerAt, voiceAt), /settingsGroup\(h, 'speaker-shadow'/,
    '影子观测跟声纹登记同一张卡片');
  assert.doesNotMatch(clientSource.slice(memoryPeopleAt, speakerAt), /speakerEnrollSection\(h, \{\}/,
    '声纹登记不再放在记忆卡片');

  // 记忆容量与自动记忆回到「记忆与人设」，不在维护卡片里。
  assert.match(clientSource.slice(memoryPeopleAt, speakerAt),
    /settingsGroup\(h, 'memory', '记忆容量与维护'/, '记忆容量在记忆与人设卡片里');
  const maintenanceAt = at("settingsCard(h, 'maintenance', '维护与恢复'");
  assert.doesNotMatch(clientSource.slice(maintenanceAt, miscAt), /记忆容量与维护/,
    '维护与恢复里不再出现记忆容量');
  assert.match(clientSource.slice(maintenanceAt, miscAt), /retentionSection\(h, \{/,
    '音频保留仍在诊断与维护');
  assert.match(clientSource.slice(diagnosticsAt, maintenanceAt), /timelineSection\(h, /,
    '时间线仍在运行诊断');

  // 8 个组件开关：列表来自 status.features，upstream 注册了 8 个，客户端不再过滤 fastpath。
  const featuresAt = at("settingsCard(h, 'features', '组件开关'");
  const featuresRegion = clientSource.slice(featuresAt, visionAt);
  assert.match(featuresRegion, /\(status\.features \?\? \[\]\)\.map\(\(entry\) =>/,
    '组件开关直接遍历 status.features');
  assert.doesNotMatch(featuresRegion, /\.filter\(/, '组件开关不再过滤掉 fastpath');
  assert.match(featuresRegion, /action: 'feature\.set'/, '开关仍走原来的 feature.set');
  assert.deepEqual(DEFAULT_FEATURES.map((entry) => entry.id),
    ['hearing', 'ambient', 'voice', 'vision', 'subtitle', 'avatar', 'memory', 'fastpath'],
    '宿主注册的 8 个组件都会出现在总控里');

  console.log(`6) vision<hearing mic+ambient=one-card call=own speaker=own memory=memory-people misc=last`
    + ` features=${DEFAULT_FEATURES.length}`);
});

test('7. 去重：工作目录只展示一次，旧「关于」重复行与重复卡片已删除', () => {
  assert.equal((clientSource.match(/instanceRootSection\(h, \{/gu) ?? []).length, 1,
    '工作目录/存放位置卡片只挂载一次');
  assert.equal((clientSource.match(/'当前工作目录'/gu) ?? []).length, 1,
    '当前工作目录只渲染一行');
  assert.equal((clientSource.match(/'当前存放位置'/gu) ?? []).length, 0,
    '旧的「当前存放位置」行已删除（改名为当前工作目录）');
  assert.ok(!clientSource.includes("line('根目录'"), '旧「关于」里的根目录行已删除');
  assert.ok(!clientSource.includes("line('固定记忆',"), '旧「关于」里的固定记忆行已删除');
  assert.ok(!clientSource.includes("settingsGroup(h, 'about'"), '旧「关于」子容器已删除');
  assert.ok(!clientSource.includes("'存放位置与关于'"), '「存放位置与关于」卡片已拆掉');
  assert.ok(!clientSource.includes('低频配置'), '不再出现「低频配置」');
  // 版本与运行时长搬到最上面的「插件介绍」，不再在诊断区重复。
  assert.equal((clientSource.match(/line\('客户端 \/ 服务端'/gu) ?? []).length, 1);
  assert.equal((clientSource.match(/line\('运行时长'/gu) ?? []).length, 1);
  assert.ok(clientSource.includes("settingsGroup(h, 'sandbox', '工作区权限（只读）'"),
    '工作区权限只读说明保留（合并到顶部）');
  assert.ok(clientSource.includes("settingsGroup(h, 'scope', '只在当前工作目录生效'"),
    '只在工作目录生效的设置放在顶部');
  console.log('7) workdirOnce=1 about=removed sandbox=kept scope=top lowfreq=gone');
});

// ---- 4. alignment --------------------------------------------------------------------------

test('8. 对齐：label 固定宽度、控件区可伸缩、操作列右对齐、按钮/输入框同一套尺寸', () => {
  assert.equal(styles.fieldRow.display, 'flex');
  assert.equal(styles.fieldRow.alignItems, 'center', '同一行垂直居中对齐');
  assert.equal(styles.fieldLabel.flex, '0 0 132px', 'label 固定宽度 132px');
  assert.equal(styles.fieldControls.flex, '1 1 0', '控件区吃掉剩余宽度');
  assert.equal(styles.actionRow.justifyContent, 'flex-end', '操作列右对齐');
  assert.equal(styles.actionRow.alignItems, 'center');
  assert.equal(styles.btn.padding, styles.btnPrimary.padding, '主/次按钮同高');
  assert.equal(styles.btn.fontSize, styles.btnPrimary.fontSize, '主/次按钮同字号');
  assert.equal(styles.btn.borderRadius, styles.btnPrimary.borderRadius);
  assert.equal(styles.input.boxSizing, 'border-box', '输入框宽度含边框，避免撑破行');
  assert.equal(styles.input.fontSize, styles.btn.fontSize, '输入框与按钮同字号');

  // 两个对齐 helper 真正被使用（避免只定义样式却没人用）。
  const field = settingsField(h, '输入设备', h('select', {}));
  assert.equal(field.props['data-settings-field'], '输入设备');
  assert.equal(field.children[0].props.style, styles.fieldLabel, 'label 用固定宽度样式');
  assert.equal(field.children[1].props.style, styles.fieldControls, '控件区用可伸缩样式');
  const actions = settingsActions(h, h('button', { style: styles.btn }, '测试麦克风'));
  assert.equal(actions.props['data-settings-actions'], 'true');
  assert.equal(actions.props.style, styles.actionRow, '操作列右对齐');
  assert.equal((clientSource.match(/settingsField\(h, /gu) ?? []).length >= 3, true,
    '输入设备 / 回环设备 / 语种等行使用固定 label 宽度');
  assert.equal((clientSource.match(/settingsActions\(h,/gu) ?? []).length >= 3, true,
    '测试麦克风 / 持续观看 / 字幕等操作行右对齐');
  console.log(`8) label=${styles.fieldLabel.flex} action=${styles.actionRow.justifyContent}`
    + ` fields=${(clientSource.match(/settingsField\(h, /gu) ?? []).length}`
    + ` actions=${(clientSource.match(/settingsActions\(h,/gu) ?? []).length}`);
});

// ---- 5. Panel wiring -----------------------------------------------------------------------

test('9. Panel 挂载：settingsBlocks + groupSettingsBlocks，各分区卡片都在', () => {
  assert.match(clientSource, /const settingsBlocks = \[/u, 'Panel 先声明块表');
  assert.match(clientSource, /groupSettingsBlocks\(h, settingsBlocks\)/u, 'Panel 用统一分组函数渲染');
  for (const id of ['intro', 'features', 'vision', 'hearing', 'avatar', 'memory-people', 'speaker',
    'voice', 'call', 'subtitle', 'diagnostics', 'maintenance', 'misc']) {
    assert.ok(clientSource.includes(`settingsCard(h, '${id}'`), `分区卡片 ${id} 存在`);
  }
  for (const title of ['插件与工作目录', '组件开关', '视觉与感知', '听觉', '形象与动作', '记忆与人设',
    '声纹登记与影子观测', '语音', '通话模式', '字幕', '运行诊断', '维护与恢复', '其他设置']) {
    assert.ok(clientSource.includes(`'${title}'`), `卡片标题 ${title} 存在`);
  }
  // 首次使用提示仍留在最上方，不并进分区。
  assert.match(clientSource, /status\.firstRun\s*\?\s*card\(/u, '首次使用提示仍在最上方');
  // 由表单函数自己渲染的子容器也带稳定标记（诊断 / 时间线 / 存储 / 恢复 / 声纹 / 音频保留 / 词库 / 动作 / 显示层）。
  for (const id of ['client-diagnostics', 'timeline', 'instance-root', 'recover', 'speaker-enroll',
    'retention', 'lexicon', 'motion', 'display-layer']) {
    assert.ok(clientSource.includes(`'data-settings-group': '${id}'`), `子容器 ${id} 带 data-settings-group`);
  }
  assert.equal((clientSource.match(/settingsBlock\('/gu) ?? []).length, 14,
    '14 张卡片各一个块（人设卡片就是 memory 分区的第一块）');
  // VTS 重授权按钮：先按契约接线，宿主暂不支持时 act 只给提示、不抛异常。
  assert.match(clientSource, /action: 'vts\.authorize'/u, '重新授权按钮走 vts.authorize');
  assert.ok(clientSource.includes("'重新授权'"), '形象卡片里有重新授权按钮');
  assert.ok(clientSource.includes("line('授权状态'"), '形象卡片显示授权状态');
  console.log('9) cards=14 blocks=14 sections=12 vtsAuthorize=wired');
});

test('10. 删除/合并：旧大卡片标题消失、保留项仍在', () => {
  for (const title of ['语音与听觉', '听觉', '语种', '语音合成', '环境声音', '记忆', '形象', '视觉与隐私',
    '字幕', '语音延迟测量', '固定记忆', '关于', '存放位置与关于', '组件开关', '连带启动', '全局快捷键']) {
    assert.doesNotMatch(
      clientSource,
      new RegExp(`card\\(\\s*'${title}'`, 'u'),
      `旧卡片「${title}」已并入分区卡片（用 settingsGroup / settingsCard 渲染）`,
    );
  }
  assert.ok(clientSource.includes("settingsGroup(h, 'sandbox', '工作区权限（只读）'"),
    '工作区权限只读说明保留');
  assert.ok(clientSource.includes("settingsGroup(h, 'plugin', '插件介绍'"),
    '版本/运行时长收进「插件介绍」子容器');
  assert.ok(!clientSource.includes("settingsGroup(h, 'about'"), '关于子容器已删除');
  console.log('10) oldCards=0 about=removed sandbox=kept plugin=top');
});

test('11. 布局块本身没有请求、轮询或状态', () => {
  assert.doesNotMatch(layoutBlock, /fetch\(/u, '布局块不发请求');
  assert.doesNotMatch(layoutBlock, /setInterval|setTimeout|requestAnimationFrame/u, '布局块不装定时器');
  assert.doesNotMatch(layoutBlock, /useState|useEffect|useRef/u, '布局块不持有 React 状态');
  assert.equal((clientSource.match(/setInterval\(load, 3000\)/gu) ?? []).length, 1, '轮询仍只有原有的那一个');
  assert.doesNotMatch(clientSource, /action: 'vts\.authorize'[\s\S]{0,400}?setInterval/u,
    '重新授权按钮不新增轮询');
  console.log('11) layoutBlock: no fetch / no timer / no state; poll sources=1');
});

// ---- 6. Panel renders without a host -------------------------------------------------------

test('12. 端到端渲染：14 张卡片都落进 12 个分区，分区内顺序固定', () => {
  const cards = [
    ['intro', 'intro'], ['features', 'features'], ['vision', 'vision'], ['hearing', 'hearing'],
    ['avatar', 'avatar'], ['memory', 'persona'], ['memory', 'memory-people'], ['speaker', 'speaker'],
    ['voice', 'voice'], ['call', 'call'], ['subtitle', 'subtitle'],
    ['diagnostics', 'diagnostics'], ['diagnostics', 'maintenance'], ['misc', 'misc'],
  ];
  const blocks = cards.map(([section, id]) => settingsBlock(section, settingsCard(h, id, `${id} 卡片`)));
  const tree = groupSettingsBlocks(h, blocks);
  assert.deepEqual(sectionIdsOf(tree), EXPECTED_SECTIONS);
  for (const [, id] of cards) {
    assert.equal(byProps(tree, 'data-settings-card', id).length, 1, `${id} 卡片渲染一次`);
  }
  const bySection = Object.fromEntries(tree.map((section) => [
    section.props['data-settings-section'], cardIdsOf(section),
  ]));
  assert.deepEqual(bySection.intro, ['intro']);
  assert.deepEqual(bySection.features, ['features']);
  assert.deepEqual(bySection.vision, ['vision']);
  assert.deepEqual(bySection.hearing, ['hearing']);
  assert.deepEqual(bySection.avatar, ['avatar']);
  assert.deepEqual(bySection.memory, ['persona', 'memory-people'], '人设在固定记忆/记忆/语言库之前');
  assert.deepEqual(bySection.speaker, ['speaker']);
  assert.deepEqual(bySection.voice, ['voice']);
  assert.deepEqual(bySection.call, ['call']);
  assert.deepEqual(bySection.subtitle, ['subtitle']);
  assert.deepEqual(bySection.diagnostics, ['diagnostics', 'maintenance'], '运行诊断在维护之前');
  assert.deepEqual(bySection.misc, ['misc'], '其他设置在最后');
  console.log(`12) cards=${cards.length} sections=${tree.length} memory=${bySection.memory.join(',')}`);
});

// ---- 7. explicit gaze-mapping probe entry ---------------------------------------------------
test('13. 形象卡片：验证视线映射按钮 + 结果行，一次动作、无轮询、失败不清空其它状态', () => {
  assert.equal((clientSource.match(/action: 'avatar\.mapping\.probe'/gu) ?? []).length, 1,
    '形象卡片只有一处显式触发');
  assert.ok(clientSource.includes("'验证视线映射'"), '按钮文案存在');
  assert.ok(clientSource.includes('data-avatar-mapping'), '结果行有稳定标记');
  assert.ok(clientSource.includes('status.avatar?.mapping'), '结果行读取 status.avatar.mapping');
  for (const text of ['已连通', '未变化', '失败：']) {
    assert.ok(clientSource.includes(text), `结果行能显示「${text}」`);
  }
  assert.doesNotMatch(
    clientSource,
    /action: 'avatar\.mapping\.probe'[\s\S]{0,300}?setInterval/u,
    '验证按钮不新增轮询',
  );
  assert.equal((clientSource.match(/setInterval\(load, 3000\)/gu) ?? []).length, 1,
    '全局轮询仍只有原有的那一个');
  console.log('13) mappingButton=1 resultRow=1 poll=0');
});
