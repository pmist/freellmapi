import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { getAllPenalties } from '../services/router.js';

export const fallbackRouter = Router();

const VALID_GROUPS = ['auto', 'planning', 'execution', 'review'] as const;
type FallbackGroup = (typeof VALID_GROUPS)[number];

function isGroup(s: string): s is FallbackGroup {
  return VALID_GROUPS.includes(s as FallbackGroup);
}

interface FallbackRow {
  model_db_id: number;
  priority: number;
  enabled: number;
  platform: string;
  model_id: string;
  display_name: string;
  intelligence_rank: number;
  speed_rank: number;
  size_label: string;
  rpm_limit: number | null;
  rpd_limit: number | null;
  monthly_token_budget: string;
}

function enrichRows(rows: FallbackRow[]) {
  const keyCounts = getDb().prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys WHERE enabled = 1
    GROUP BY platform
  `).all() as { platform: string; count: number }[];
  const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));

  const penalties = getAllPenalties();
  const penaltyMap = new Map(penalties.map(p => [p.modelDbId, p]));

  return rows.map(r => {
    const penalty = penaltyMap.get(r.model_db_id);
    return {
      modelDbId: r.model_db_id,
      priority: r.priority,
      effectivePriority: r.priority + (penalty?.penalty ?? 0),
      penalty: penalty?.penalty ?? 0,
      rateLimitHits: penalty?.count ?? 0,
      enabled: r.enabled === 1,
      platform: r.platform,
      modelId: r.model_id,
      displayName: r.display_name,
      intelligenceRank: r.intelligence_rank,
      speedRank: r.speed_rank,
      sizeLabel: r.size_label,
      rpmLimit: r.rpm_limit,
      rpdLimit: r.rpd_limit,
      monthlyTokenBudget: r.monthly_token_budget,
      keyCount: keyCountMap.get(r.platform) ?? 0,
    };
  });
}

// ── Backward-compatible: get all entries from all groups as flat list ──
fallbackRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT fc.model_db_id, fc.priority, fc.enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.speed_rank, m.size_label, m.rpm_limit, m.rpd_limit,
           m.monthly_token_budget
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    ORDER BY fc.fallback_group, fc.priority ASC
  `).all() as FallbackRow[];
  res.json(enrichRows(rows));
});

const updateSchema = z.array(z.object({
  modelDbId: z.number(),
  priority: z.number(),
  enabled: z.boolean(),
}));

// ── Backward-compatible: update all entries ──
fallbackRouter.put('/', (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const update = db.prepare(`UPDATE fallback_config SET priority = ?, enabled = ? WHERE model_db_id = ?`);

  const updateAll = db.transaction(() => {
    for (const entry of parsed.data) {
      update.run(entry.priority, entry.enabled ? 1 : 0, entry.modelDbId);
    }
  });
  updateAll();

  res.json({ success: true });
});

// ── Backward-compatible: sort presets across all groups ──
fallbackRouter.post('/sort/:preset', (req: Request, res: Response) => {
  const { preset } = req.params;
  const db = getDb();

  let orderBy: string;
  switch (preset) {
    case 'intelligence':
      orderBy = 'm.intelligence_rank ASC';
      break;
    case 'speed':
      orderBy = 'm.speed_rank ASC';
      break;
    case 'budget':
      orderBy = "CASE m.monthly_token_budget WHEN '~120M' THEN 1 WHEN '~50-100M' THEN 2 WHEN '~30M' THEN 3 WHEN '~18-45M' THEN 4 WHEN '~18M' THEN 5 WHEN '~15M' THEN 6 WHEN '~12M' THEN 7 WHEN '~6M' THEN 8 WHEN '~5-10M' THEN 9 WHEN '~4M' THEN 10 ELSE 11 END ASC";
      break;
    default:
      res.status(400).json({ error: { message: `Unknown preset: ${preset}. Use: intelligence, speed, budget` } });
      return;
  }

  for (const group of VALID_GROUPS) {
    const models = db.prepare(`
      SELECT fc.model_db_id FROM fallback_config fc
      JOIN models m ON m.id = fc.model_db_id
      WHERE fc.fallback_group = ?
      ORDER BY ${orderBy}
    `).all(group) as { model_db_id: number }[];

    const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ? AND fallback_group = ?');
    for (let i = 0; i < models.length; i++) {
      update.run(i + 1, models[i].model_db_id, group);
    }
  }

  res.json({ success: true, preset });
});

// ── Get all available models (for the add-model dialog) ──
fallbackRouter.get('/models', (_req: Request, res: Response) => {
  const db = getDb();
  const models = db.prepare(`
    SELECT id, platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
           rpm_limit, rpd_limit, monthly_token_budget
    FROM models
    WHERE enabled = 1
    ORDER BY intelligence_rank ASC
  `).all() as any[];

  res.json(models.map(m => ({
    id: m.id,
    platform: m.platform,
    modelId: m.model_id,
    displayName: m.display_name,
    intelligenceRank: m.intelligence_rank,
    speedRank: m.speed_rank,
    sizeLabel: m.size_label,
    rpmLimit: m.rpm_limit,
    rpdLimit: m.rpd_limit,
    monthlyTokenBudget: m.monthly_token_budget,
  })));
});

// ── Get all groups with their models ──
fallbackRouter.get('/groups', (_req: Request, res: Response) => {
  const db = getDb();
  const allGroups: Record<string, any[]> = {};

  for (const group of VALID_GROUPS) {
    const rows = db.prepare(`
      SELECT fc.model_db_id, fc.priority, fc.enabled,
             m.platform, m.model_id, m.display_name, m.intelligence_rank,
             m.speed_rank, m.size_label, m.rpm_limit, m.rpd_limit,
             m.monthly_token_budget
      FROM fallback_config fc
      JOIN models m ON m.id = fc.model_db_id
      WHERE fc.fallback_group = ?
      ORDER BY fc.priority ASC
    `).all(group) as FallbackRow[];

    allGroups[group] = enrichRows(rows);
  }

  res.json(allGroups);
});

// ── Update priorities within a group (full replace) ──
const reorderSchema = z.array(z.object({
  modelDbId: z.number(),
  priority: z.number(),
}));

fallbackRouter.put('/group/:group', (req: Request, res: Response) => {
  const group = req.params.group as string;
  if (!isGroup(group)) {
    res.status(400).json({ error: { message: `Invalid group: ${group}. Use: auto, planning, execution, review` } });
    return;
  }

  const parsed = reorderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const update = db.prepare(`
    UPDATE fallback_config SET priority = ?, fallback_group = ? WHERE model_db_id = ?
  `);

  const updateAll = db.transaction(() => {
    for (const entry of parsed.data) {
      update.run(entry.priority, group, entry.modelDbId);
    }
  });
  updateAll();

  res.json({ success: true });
});

// ── Add models to a group ──
const addModelsSchema = z.object({
  modelDbIds: z.array(z.number()).min(1),
});

fallbackRouter.post('/group/:group/models', (req: Request, res: Response) => {
  const group = req.params.group as string;
  if (!isGroup(group)) {
    res.status(400).json({ error: { message: `Invalid group: ${group}. Use: auto, planning, execution, review` } });
    return;
  }

  const parsed = addModelsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO fallback_config (model_db_id, priority, enabled, fallback_group)
    VALUES (?, ?, 1, ?)
  `);

  const findMaxPriority = db.prepare(`
    SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config WHERE fallback_group = ?
  `);

  const apply = db.transaction(() => {
    const { mx: currentMax } = findMaxPriority.get(group) as { mx: number };
    for (let i = 0; i < parsed.data.modelDbIds.length; i++) {
      insert.run(parsed.data.modelDbIds[i], currentMax + i + 1, group);
    }
  });
  apply();

  res.json({ success: true });
});

// ── Remove a model from a group ──
fallbackRouter.delete('/group/:group/models/:modelDbId', (req: Request, res: Response) => {
  const group = req.params.group as string;
  const modelDbId = parseInt(req.params.modelDbId as string, 10);
  if (!isGroup(group)) {
    res.status(400).json({ error: { message: `Invalid group: ${group}. Use: auto, planning, execution, review` } });
    return;
  }

  const db = getDb();
  db.prepare(`DELETE FROM fallback_config WHERE model_db_id = ? AND fallback_group = ?`)
    .run(modelDbId, group);

  // Re-normalize priorities
  const remaining = db.prepare(`
    SELECT model_db_id FROM fallback_config
    WHERE fallback_group = ?
    ORDER BY priority ASC
  `).all(group) as { model_db_id: number }[];

  const update = db.prepare(`UPDATE fallback_config SET priority = ? WHERE model_db_id = ? AND fallback_group = ?`);
  const reorder = db.transaction(() => {
    for (let i = 0; i < remaining.length; i++) {
      update.run(i + 1, remaining[i].model_db_id, group);
    }
  });
  reorder();

  res.json({ success: true });
});

// ── Sort within a group ──
fallbackRouter.post('/group/:group/sort/:preset', (req: Request, res: Response) => {
  const group = req.params.group as string;
  const preset = req.params.preset as string;
  if (!isGroup(group)) {
    res.status(400).json({ error: { message: `Invalid group: ${group}. Use: auto, planning, execution, review` } });
    return;
  }

  const db = getDb();

  let orderBy: string;
  switch (preset) {
    case 'intelligence':
      orderBy = 'm.intelligence_rank ASC';
      break;
    case 'speed':
      orderBy = 'm.speed_rank ASC';
      break;
    case 'budget':
      orderBy = "CASE m.monthly_token_budget WHEN '~120M' THEN 1 WHEN '~50-100M' THEN 2 WHEN '~30M' THEN 3 WHEN '~18-45M' THEN 4 WHEN '~18M' THEN 5 WHEN '~15M' THEN 6 WHEN '~12M' THEN 7 WHEN '~6M' THEN 8 WHEN '~5-10M' THEN 9 WHEN '~4M' THEN 10 ELSE 11 END ASC";
      break;
    default:
      res.status(400).json({ error: { message: `Unknown preset: ${preset}. Use: intelligence, speed, budget` } });
      return;
  }

  const models = db.prepare(`
    SELECT fc.model_db_id FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    WHERE fc.fallback_group = ?
    ORDER BY ${orderBy}
  `).all(group) as { model_db_id: number }[];

  const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ? AND fallback_group = ?');
  const reorder = db.transaction(() => {
    for (let i = 0; i < models.length; i++) {
      update.run(i + 1, models[i].model_db_id, group);
    }
  });
  reorder();

  res.json({ success: true, group, preset });
});
