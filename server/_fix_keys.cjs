const Database = require('better-sqlite3');
const db = new Database('data/freeapi.db');
const r = db.prepare('UPDATE api_keys SET enabled = 1 WHERE id = 12').run();
console.log('Enabled deepseek key:', r.changes);
const check = db.prepare('SELECT id, platform, status, enabled FROM api_keys').all();
console.log('All keys now:');
check.forEach(k => console.log(`  id=${k.id} ${k.platform}: status=${k.status} enabled=${k.enabled}`));
db.close();
