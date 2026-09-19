import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb, importModels } from '../../db/index.js';

describe('importModels (replace per provider)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('keeps only the imported models for the provider and adds them to a fallback group', () => {
    const db = getDb();
    const beforeGroq = (db.prepare("SELECT COUNT(*) AS c FROM models WHERE platform = 'groq'").get() as { c: number }).c;
    const beforeGoogle = (db.prepare("SELECT COUNT(*) AS c FROM models WHERE platform = 'google'").get() as { c: number }).c;
    expect(beforeGroq).toBeGreaterThan(1);

    const result = importModels(db, 'groq', [
      { id: 'groq-new-a', name: 'Groq New A' },
      { id: 'groq-new-b', name: 'Groq New B' },
    ]);

    expect(result.inserted).toBe(2);
    expect(result.removed).toBe(beforeGroq);

    const after = db.prepare("SELECT model_id, source FROM models WHERE platform = 'groq'").all() as { model_id: string; source: string }[];
    expect(after.map(m => m.model_id).sort()).toEqual(['groq-new-a', 'groq-new-b']);
    expect(after.every(m => m.source === 'import')).toBe(true);

    const fb = db.prepare(`
      SELECT m.model_id FROM fallback_config f JOIN models m ON m.id = f.model_db_id WHERE m.platform = 'groq'
    `).all() as { model_id: string }[];
    expect(fb.map(m => m.model_id).sort()).toEqual(['groq-new-a', 'groq-new-b']);

    // Other platforms are untouched.
    expect((db.prepare("SELECT COUNT(*) AS c FROM models WHERE platform = 'google'").get() as { c: number }).c).toBe(beforeGoogle);
  });

  it('re-importing the same set removes nothing', () => {
    const db = getDb();
    const result = importModels(db, 'groq', [
      { id: 'groq-new-a', name: 'Groq New A' },
      { id: 'groq-new-b', name: 'Groq New B' },
    ]);
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.removed).toBe(0);
  });

  it('importing a subset removes the models that were not selected', () => {
    const db = getDb();
    const result = importModels(db, 'groq', [{ id: 'groq-new-a', name: 'Groq New A' }]);
    expect(result.removed).toBe(1);
    const after = db.prepare("SELECT model_id FROM models WHERE platform = 'groq'").all() as { model_id: string }[];
    expect(after.map(m => m.model_id)).toEqual(['groq-new-a']);
  });
});
