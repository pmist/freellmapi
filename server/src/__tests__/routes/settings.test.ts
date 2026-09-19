import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('Settings API - routing strategy', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  it('GET /api/settings/routing returns the current strategy', async () => {
    const { status, body } = await request(app, 'GET', '/api/settings/routing');
    expect(status).toBe(200);
    expect(['priority', 'random']).toContain(body.strategy);
  });

  it('PUT /api/settings/routing updates and persists the strategy', async () => {
    const { status, body } = await request(app, 'PUT', '/api/settings/routing', { strategy: 'priority' });
    expect(status).toBe(200);
    expect(body.strategy).toBe('priority');

    const { body: after } = await request(app, 'GET', '/api/settings/routing');
    expect(after.strategy).toBe('priority');

    await request(app, 'PUT', '/api/settings/routing', { strategy: 'random' });
  });

  it('PUT /api/settings/routing rejects invalid values', async () => {
    const { status } = await request(app, 'PUT', '/api/settings/routing', { strategy: 'nope' });
    expect(status).toBe(400);
  });
});
