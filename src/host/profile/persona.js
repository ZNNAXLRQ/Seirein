/**
 * Persona and user profile as plain Markdown the agent maintains through tools.
 *
 * Files are an implementation detail: the user never edits them. The agent appends when the
 * user states a lasting preference ("以后说话短一点"), then answers with a short confirmation.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HEADER = `# 人设与用户画像\n\n> 由助手在对话中维护，用户不需要编辑本文件。\n`;

export class PersonaStore {
  constructor(root) {
    this.dir = join(root, 'memory');
  }

  /** @param {'agent'|'user'} which */
  file(which) {
    return join(this.dir, which === 'user' ? 'user.md' : 'persona.md');
  }

  read(which) {
    try {
      return readFileSync(this.file(which), 'utf8');
    } catch {
      return '';
    }
  }

  /** Append one line to the given profile. Returns the stored line. */
  append(which, text) {
    const line = `- ${text.trim()}`;
    mkdirSync(this.dir, { recursive: true });
    const existing = this.read(which);
    if (existing.length === 0) appendFileSync(this.file(which), `${HEADER}\n`, 'utf8');
    appendFileSync(this.file(which), `${line}\n`, 'utf8');
    return line;
  }

  /** Replace the whole profile (used by the settings editor). */
  write(which, text) {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(which), `${String(text ?? '').trimEnd()}\n`, 'utf8');
    return text;
  }

  /** Both profiles, trimmed to a prompt budget. */
  render({ budget = 1200 } = {}) {
    const parts = [];
    for (const [which, label] of [['agent', '你的设定'], ['user', '关于用户']]) {
      const text = this.read(which).trim();
      if (text.length === 0) continue;
      const body = text.length > budget ? `${text.slice(0, budget)}…（已截断）` : text;
      parts.push(`## ${label}\n${body}`);
    }
    return parts.join('\n\n');
  }
}
