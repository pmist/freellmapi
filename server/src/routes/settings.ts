import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getUnifiedApiKey, regenerateUnifiedKey } from '../db/index.js';
import { getRoutingStrategy, setRoutingStrategy } from '../services/router.js';

export const settingsRouter = Router();

// Get the unified API key
settingsRouter.get('/api-key', (_req: Request, res: Response) => {
  res.json({ apiKey: getUnifiedApiKey() });
});

// Regenerate the unified API key
settingsRouter.post('/api-key/regenerate', (_req: Request, res: Response) => {
  const newKey = regenerateUnifiedKey();
  res.json({ apiKey: newKey });
});

// ── Routing strategy ──
settingsRouter.get('/routing', (_req: Request, res: Response) => {
  res.json({ strategy: getRoutingStrategy() });
});

const routingSchema = z.object({ strategy: z.enum(['priority', 'random']) });

settingsRouter.put('/routing', (req: Request, res: Response) => {
  const parsed = routingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'strategy must be "priority" or "random"' } });
    return;
  }
  setRoutingStrategy(parsed.data.strategy);
  res.json({ strategy: parsed.data.strategy });
});
