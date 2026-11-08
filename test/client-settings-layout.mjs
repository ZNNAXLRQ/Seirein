/**
 * 设置页信息架构回归：
 *   1. 分区顺序固定为「常用 → 记忆与人设 → 诊断与维护 → 高级」，常用在上、诊断在下；
 *   2. 同一大功能的子项合并进一张分区卡片，卡片内部用圆角子容器 + 分隔线组织；
 *   3. 子容器样式：8–10px 圆角、很浅的灰底（#f6f8fa）、10–12px 内边距；
 *   4. 行内 label 固定宽度、操作列右对齐，按钮/输入框同一套尺寸；
 *   5. 旧版重复/无效的块已删除（关于里的「根目录」「固定记忆」重复行、旧的大卡片标题）。
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
  SETTINGS_SECTIONS, SETTINGS_SECTION_IDS, settingsBlock, settingsCard, settingsGroup,
  settingsDivider, settingsField, settingsActions, groupSettingsBlocks,
};`,
)(styles);

const {
  SETTINGS_SECTIONS, settingsBlock, settingsCard, settingsGroup, settingsDivider,
  settingsField, settingsActions, groupSettingsBlocks,
} = layout;

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

// ---- 1. section order ----------------------------------------------------------------------

test('1. 分区顺序：常用 → 记忆与人设 → 诊断与维护 → 高级（折叠），常用永远在诊断之前', () => {
  const tree = groupSettingsBlocks(h, [
    settingsBlock('advanced', h('div', { 'data-card': 'hotkeys' })),
    settingsBlock('diagnostics', h('div', { 'data-card': 'diagnostics' })),
    settingsBlock('common', h('div', { 'data-card': 'voice' })),
    settingsBlock('memory', h('div', { 'data-card': 'persona' })),
  ]);
  assert.deepEqual(
    tree.map((section) => section.props['data-settings-section']),
    ['common', 'memory', 'diagnostics', 'advanced'],
    '渲染顺序与 SETTINGS_SECTIONS 一致，与块的声明顺序无关',
  );
  assert.deepEqual(SETTINGS_SECTIONS.map((section) => section.title), [
    '一、常用', '二、记忆与人设', '三、诊断与维护', '四、高级（低频配置）',
  ]);
  const titles = textsOf(tree);
  for (const title of ['一、常用', '二、记忆与人设', '三、诊断与维护', '四、高级（低频配置）']) {
    assert.ok(titles.includes(title), `分区标题可见：${title}`);
  }
  console.log(`1) order=${tree.map((section) => section.props['data-settings-section']).join(' → ')}`);
});

test('2. 四个分区都有 heading；高级分区包在 <details> 里默认折叠', () => {
  const tree = groupSettingsBlocks(h, SETTINGS_SECTIONS.map((section) => (
    settingsBlock(section.id, settingsCard(h, `${section.id}-card`, `${section.id} 卡片`))
  )));
  for (const section of SETTINGS_SECTIONS) {
    assert.equal(byProps(tree, 'data-settings-heading', section.id).length, 1,
      `${section.id} renders exactly one heading`);
    assert.equal(byProps(tree, 'data-settings-body', section.id).length, 1,
      `${section.id} renders exactly one body`);
  }
  const advanced = tree.find((section) => section.props['data-settings-section'] === 'advanced');
  const details = byProps(advanced, 'data-settings-collapsed', 'true');
  assert.equal(details.length, 1, '高级分区用 <details> 折叠');
  assert.equal(details[0].type, 'details');
  const summary = details[0].children.find((child) => child?.type === 'summary');
  assert.ok(summary, '折叠分区有 summary 标题');
  assert.ok(textsOf(summary).includes('四、高级（低频配置）'));
  const common = tree.find((section) => section.props['data-settings-section'] === 'common');
  assert.equal(byProps(common, 'data-settings-collapsed', 'true').length, 0, '常用分区不折叠');
  console.log(`2) headings=${SETTINGS_SECTIONS.length} collapsed=advanced`);
});

test('3. 未知分区与数组块：落到高级，不会被静默丢弃', () => {
  const stray = h('div', { 'data-card': 'stray' });
  const tree = groupSettingsBlocks(h, [
    settingsBlock('nope', stray),
    settingsBlock('common', [h('div', { 'data-card': 'a' }), h('div', { 'data-card': 'b' })]),
  ]);
  assert.deepEqual(tree.map((section) => section.props['data-settings-section']), ['common', 'advanced']);
  const advanced = tree.find((section) => section.props['data-settings-section'] === 'advanced');
  const cards = byProps(advanced, 'data-card', 'stray');
  assert.equal(cards.length, 1, '未知分区的块仍然渲染（落到高级）');
  const common = tree.find((section) => section.props['data-settings-section'] === 'common');
  assert.equal(byProps(common, 'data-card', 'a').length, 1);
  assert.equal(byProps(common, 'data-card', 'b').length, 1);
  assert.deepEqual(groupSettingsBlocks(h, []), [], '空块表不渲染空分区');
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
    '语音与听觉',
    settingsGroup(h, 'mic', '麦克风与门限'),
    settingsGroup(h, 'tts', '语音合成与候音'),
    settingsGroup(h, 'ambient', '环境声音'),
  );
  assert.equal(card.props['data-settings-card'], 'voice');
  assert.equal(styles.sectionCard.background, '#fff');
  assert.equal(styles.sectionCard.borderRadius, 12);
  const dividers = card.children.filter((child) => child !== null && child.props?.['data-settings-divider']);
  assert.equal(dividers.length, 2, '三个子容器之间有两条分隔线');
  assert.equal(dividers[0].type, 'div');
  assert.equal(dividers[0].props.role, 'separator');
  for (const id of ['mic', 'tts', 'ambient']) {
    assert.equal(byProps(card, 'data-settings-group', id).length, 1, `${id} 子容器在卡片里`);
  }
  const divider = settingsDivider(h, 'voice-1');
  assert.equal(divider.props['data-settings-divider'], 'voice-1');
  assert.equal(styles.divider.borderTop, '1px solid #e5e9ef');
  console.log(`5) dividers=${dividers.length} groups=3`);
});

test('6. 语音与听觉卡片的子容器顺序：麦克风 → 通话模式 → 语种 → 语音合成 → 环境声音', () => {
  const expected = ['mic', 'call-mode', 'language', 'tts', 'ambient'];
  const positions = expected.map((id) => clientSource.indexOf(`settingsGroup(h, '${id}'`));
  for (let i = 0; i < positions.length; i += 1) {
    assert.ok(positions[i] > 0, `client.js 渲染子容器 ${expected[i]}`);
    if (i > 0) assert.ok(positions[i] > positions[i - 1], `${expected[i - 1]} 在 ${expected[i]} 之前`);
  }
  // 声纹影子与声纹登记同属「二、记忆与人设」：登记 → 影子，且都在 音频保留 之前。
  const enrollAt = clientSource.indexOf('speakerEnrollSection(h, {');
  const shadowAt = clientSource.indexOf("settingsGroup(h, 'speaker-shadow'");
  const retentionMount = /\n\s+retentionSection\(h, \{/u.exec(clientSource);
  assert.ok(enrollAt > 0 && shadowAt > enrollAt, '声纹影子紧跟声纹登记');
  assert.ok(retentionMount !== null && retentionMount.index > shadowAt,
    '声纹相关配置都在诊断与维护之前');
  console.log(`6) groups=${expected.join(' → ')} shadow=after-enroll`);
});

// ---- 3. alignment --------------------------------------------------------------------------

test('7. 对齐：label 固定宽度、控件区可伸缩、操作列右对齐、按钮/输入框同一套尺寸', () => {
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

  // 两个对齐helper 真正被使用（避免只定义样式却没人用）。
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
  console.log(`7) label=${styles.fieldLabel.flex} action=${styles.actionRow.justifyContent}`
    + ` fields=${(clientSource.match(/settingsField\(h, /gu) ?? []).length}`
    + ` actions=${(clientSource.match(/settingsActions\(h,/gu) ?? []).length}`);
});

// ---- 4. Panel wiring -----------------------------------------------------------------------

test('8. Panel 挂载：settingsBlocks + groupSettingsBlocks，四个分区的卡片都在', () => {
  assert.match(clientSource, /const settingsBlocks = \[/u, 'Panel 先声明块表');
  assert.match(clientSource, /groupSettingsBlocks\(h, settingsBlocks\)/u, 'Panel 用统一分组函数渲染');
  for (const id of ['voice', 'avatar', 'vision', 'subtitle', 'memory-people', 'diagnostics', 'maintenance', 'storage']) {
    assert.ok(clientSource.includes(`settingsCard(h, '${id}'`), `分区卡片 ${id} 存在`);
  }
  for (const title of ['语音与听觉', '形象与动作', '视觉与感知', '字幕', '记忆与人设', '运行诊断', '维护与恢复', '存放位置与关于']) {
    assert.ok(clientSource.includes(`'${title}'`), `卡片标题 ${title} 存在`);
  }
  // 首次使用提示仍留在最上方，不并进分区。
  assert.match(clientSource, /status\.firstRun\s*\?\s*card\(/u, '首次使用提示仍在最上方');
  // 由表单函数自己渲染的子容器也带稳定标记（诊断 / 时间线 / 恢复 / 声纹 / 音频保留 / 词库 / 动作 / 显示层）。
  for (const id of ['client-diagnostics', 'timeline', 'instance-root', 'recover', 'speaker-enroll',
    'retention', 'lexicon', 'motion', 'display-layer']) {
    assert.ok(clientSource.includes(`'data-settings-group': '${id}'`), `子容器 ${id} 带 data-settings-group`);
  }
  console.log('8) blocks=13 sections=4');
});

test('9. 删除/合并：旧大卡片标题消失、重复的关于行消失、保留项仍在', () => {
  for (const title of ['听觉', '语种', '语音合成', '环境声音', '记忆', '形象', '视觉与隐私', '字幕',
    '语音延迟测量', '固定记忆']) {
    assert.doesNotMatch(
      clientSource,
      new RegExp(`card\\(\\s*'${title}'`, 'u'),
      `旧卡片「${title}」已并入分区卡片（用 settingsGroup / settingsCard 渲染）`,
    );
  }
  assert.ok(!clientSource.includes("line('根目录'"), '关于卡片里重复的「根目录」行已删除');
  assert.ok(!clientSource.includes("line('固定记忆',"), '关于卡片里重复的「固定记忆」行已删除');
  // 有疑问的只读块保留，只是移到诊断与维护。
  assert.ok(clientSource.includes("settingsGroup(h, 'sandbox', '工作区权限（只读）'"),
    '工作区权限只读说明保留（移到诊断与维护）');
  assert.ok(clientSource.includes("settingsGroup(h, 'about', '关于'"), '版本/运行时长/人设字符收进「关于」子容器');
  console.log('9) oldCards=0 aboutDup=0 sandbox=kept');
});

test('10. 布局块本身没有请求、轮询或状态', () => {
  assert.doesNotMatch(layoutBlock, /fetch\(/u, '布局块不发请求');
  assert.doesNotMatch(layoutBlock, /setInterval|setTimeout|requestAnimationFrame/u, '布局块不装定时器');
  assert.doesNotMatch(layoutBlock, /useState|useEffect|useRef/u, '布局块不持有 React 状态');
  assert.equal((clientSource.match(/setInterval\(load, 3000\)/gu) ?? []).length, 1, '轮询仍只有原有的那一个');
  console.log('10) layoutBlock: no fetch / no timer / no state; poll sources=1');
});

// ---- 5. Panel renders without a host -------------------------------------------------------

test('11. 端到端渲染：用记录型 h 跑一遍分区组装，所有块都落进四个分区', () => {
  const cards = ['voice', 'avatar', 'vision', 'subtitle', 'persona', 'memory-people',
    'diagnostics', 'maintenance', 'storage', 'features', 'autostart', 'hotkeys', 'fastpath'];
  const blocks = cards.map((id) => settingsBlock(
    ['features', 'autostart', 'hotkeys', 'fastpath'].includes(id) ? 'advanced'
      : ['persona', 'memory-people'].includes(id) ? 'memory'
        : ['diagnostics', 'maintenance', 'storage'].includes(id) ? 'diagnostics'
          : 'common',
    settingsCard(h, id, `${id} 卡片`),
  ));
  const tree = groupSettingsBlocks(h, blocks);
  assert.deepEqual(tree.map((section) => section.props['data-settings-section']),
    ['common', 'memory', 'diagnostics', 'advanced']);
  for (const card of cards) {
    assert.equal(byProps(tree, 'data-settings-card', card).length, 1, `${card} 卡片渲染一次`);
  }
  const common = tree.find((section) => section.props['data-settings-section'] === 'common');
  const commonCards = nodesOf(common).filter((node) => typeof node.props['data-settings-card'] === 'string');
  assert.deepEqual(
    commonCards.map((node) => node.props['data-settings-card']),
    ['voice', 'avatar', 'vision', 'subtitle'],
    '常用分区内按 语音 → 形象 → 视觉 → 字幕 排列',
  );
  console.log(`11) cards=${cards.length} common=${commonCards.map((node) => node.props['data-settings-card']).join(',')}`);
});
