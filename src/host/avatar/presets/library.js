/**
 * User-editable avatar motion preset library.
 *
 * The built-in catalog is a code fallback, not the user's source of truth. On first use the host
 * writes the complete catalog to `<root>/avatar/presets/presets.json`; later starts read that file
 * so a user can edit, remove, or add presets without touching the plugin package. The runtime gets
 * the loaded array through `config.presetCatalog`; an invalid file never crashes motion and falls
 * back to the built-ins with a status-visible error.
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export const PRESET_LIBRARY_DIR = 'avatar/presets';
export const PRESET_LIBRARY_FILE = 'presets.json';

const LIBRARY_README = `# Seirein 形象动作预设

编辑 \`presets.json\` 可以增加、删除或修改动作预设。文件是完整词库，不是补丁：

- \`presets\` 是数组，至少保留一个有效条目；
- 每项必须包含 \`id\`、\`family\`、\`states\`、\`events\`、\`requires\`、\`operations\`、\`timing\`；
- \`timing\` 必须是对象；\`operations\` 是本动作包含的操作；
- 不要在文件里写函数、import 或 eval 表达式；
- 保存后重启 DSH 生效，当前运行中的会话不会热替换词库；
- 文件损坏时会回退到插件内置词库，并在状态事件 \`avatar.presets.library\` 中报告错误。

内置词库由插件提供，首次启动复制到这里；之后这个文件归用户维护。
`;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** One row must be safe to hand to the pure selector; unknown extra fields are preserved. */
export function validPresetRow(row) {
  return isObject(row)
    && typeof row.id === 'string' && row.id.trim().length > 0
    && typeof row.family === 'string' && row.family.trim().length > 0
    && Array.isArray(row.states)
    && Array.isArray(row.events)
    && Array.isArray(row.requires)
    && Array.isArray(row.operations)
    && isObject(row.timing);
}

function validRows(rows) {
  return Array.isArray(rows) ? rows.filter(validPresetRow) : [];
}

/**
 * Read the user library, creating it from built-ins on first use.
 * @param {{root: string, builtins: Array<object>, now?: () => number}} options
 * @returns {{directory: string, file: string, presets: Array<object>, source: string, created: boolean, error: string}}
 */
export function loadPresetLibrary({ root, builtins, now = Date.now }) {
  const directory = join(root, PRESET_LIBRARY_DIR);
  const file = join(directory, PRESET_LIBRARY_FILE);
  const readme = join(directory, 'README.md');
  try {
    mkdirSync(directory, { recursive: true });
    if (!existsSync(readme)) writeFileSync(readme, LIBRARY_README, 'utf8');
  } catch (error) {
    return {
      directory, file, presets: builtins, source: 'builtin', created: false,
      error: `cannot create preset library: ${error?.message ?? String(error)}`,
    };
  }
  if (!existsSync(file)) {
    try {
      writeFileSync(file, `${JSON.stringify({
        schemaVersion: 1,
        generatedAt: new Date(now()).toISOString(),
        source: 'seirein-builtin',
        presets: builtins,
      }, null, 2)}\n`, 'utf8');
      return { directory, file, presets: builtins, source: 'builtin-copy', created: true, error: '' };
    } catch (error) {
      return {
        directory, file, presets: builtins, source: 'builtin', created: false,
        error: `cannot create preset library: ${error?.message ?? String(error)}`,
      };
    }
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const rows = validRows(parsed?.presets);
    if (rows.length === 0) {
      return {
        directory, file, presets: builtins, source: 'builtin-fallback', created: false,
        error: 'presets.json has no valid preset row; built-in catalog used',
      };
    }
    return { directory, file, presets: rows, source: 'user', created: false, error: '' };
  } catch (error) {
    return {
      directory, file, presets: builtins, source: 'builtin-fallback', created: false,
      error: `presets.json is unreadable: ${error?.message ?? String(error)}`,
    };
  }
}
