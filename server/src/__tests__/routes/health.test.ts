import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';

async function request(app: Express, method: string, path: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, { method });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('Health API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  it('GET /api/health returns platforms and keys', async () => {
    const { status, body } = await request(app, 'GET', '/api/health');
    expect(status).toBe(200);
    expect(body).toHaveProperty('platforms');
    expect(body).toHaveProperty('keys');
  });

  it('POST /api/health/reset clears runtime state', async () => {
    const { status, body } = await request(app, 'POST', '/api/health/reset');
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
  });
});
