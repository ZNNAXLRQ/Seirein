import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const file = join(process.env.LOCALAPPDATA, 'dsh-assistant', 'memory', 'memory.db');
const db = new DatabaseSync(file);
console.log('rows', JSON.stringify(db.prepare('select domain, text from memory_event').all()));
console.log('like', JSON.stringify(db.prepare('select text from memory_event where text like ?').all('%记忆库%')));
try {
  console.log('fts', JSON.stringify(db.prepare('select rowid from memory_fts where memory_fts match ?').all('"记忆库"')));
} catch (error) {
  console.log('fts error', error.message);
}
db.close();
