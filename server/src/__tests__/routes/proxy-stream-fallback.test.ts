import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json, headers: res.headers, raw: data };
}

interface FirstError {
  status: number;
  statusText: string;
  body: any;
}

/**
 * Runs a streaming chat completion where the FIRST provider call fails with the
 * given pre-stream error and the SECOND streams a valid chunk. Returns the
 * client response plus the list of provider URLs hit.
 */
async function runStreamingFallback(app: Express, firstError: FirstError) {
  const origFetch = global.fetch;
  const providerCalls: string[] = [];
  let failFirst = true;

  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const urlStr = typeof url === 'string' ? url : url.toString();

    // Pass through requests back to our in-process test server.
    if (urlStr.includes('127.0.0.1') || urlStr.includes('localhost')) {
      return origFetch(url, init);
    }

    providerCalls.push(urlStr);

    if (failFirst) {
      failFirst = false;
      return {
        ok: false,
        status: firstError.status,
        statusText: firstError.statusText,
        json: () => Promise.resolve(firstError.body),
      } as any;
    }

    const encoder = new TextEncoder();
    const payload = JSON.stringify({
      id: 'chatcmpl-fallback',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'openai/gpt-oss-120b',
      choices: [{ index: 0, delta: { content: 'recovered' }, finish_reason: null }],
    });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${payload}\n\ndata: [DONE]\n\n`));
        controller.close();
      },
    });
    return { ok: true, status: 200, body: stream, json: async () => ({}) } as any;
  });

  const res = await request(app, 'POST', '/v1/chat/completions', {
    messages: [{ role: 'user', content: 'hello' }],
    stream: true,
  });

  return { ...res, providerCalls };
}

describe('Proxy streaming fallback', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(async () => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();

    const addKey = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_proxy_stream_fallback',
      label: 'proxy-stream-fallback',
    });
    expect(addKey.status).toBe(201);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back when a streaming provider fails before the first chunk', async () => {
    const { status, headers, raw, providerCalls } = await runStreamingFallback(app, {
      status: 400,
      statusText: 'Bad Request',
      body: { error: { message: "Bad input: Error: oneOf at '/' not met" } },
    });

    expect(status).toBe(200);
    // The first (failing) provider must not have terminated the request.
    expect(providerCalls.length).toBeGreaterThanOrEqual(2);
    expect(headers.get('x-fallback-attempts')).toBe('1');
    expect(raw).toContain('recovered');
    expect(raw).toContain('[DONE]');
  });

  it('falls back when the provider no longer serves the model (404)', async () => {
    const { status, headers, raw, providerCalls } = await runStreamingFallback(app, {
      status: 404,
      statusText: 'Not Found',
      body: { error: { message: 'model_not_found' } },
    });

    expect(status).toBe(200);
    expect(providerCalls.length).toBeGreaterThanOrEqual(2);
    expect(headers.get('x-fallback-attempts')).toBe('1');
    expect(raw).toContain('recovered');
  });

  it('falls back when the key is unauthorized (401)', async () => {
    const { status, headers, raw, providerCalls } = await runStreamingFallback(app, {
      status: 401,
      statusText: 'Unauthorized',
      body: { error: { message: 'Invalid API Key' } },
    });

    expect(status).toBe(200);
    expect(providerCalls.length).toBeGreaterThanOrEqual(2);
    expect(headers.get('x-fallback-attempts')).toBe('1');
    expect(raw).toContain('recovered');
  });

  it('falls back on any non-2xx status, even one with no matching error text (422)', async () => {
    const { status, headers, raw, providerCalls } = await runStreamingFallback(app, {
      status: 422,
      statusText: 'Unprocessable Entity',
      body: { error: { message: 'unprocessable' } },
    });

    expect(status).toBe(200);
    expect(providerCalls.length).toBeGreaterThanOrEqual(2);
    expect(headers.get('x-fallback-attempts')).toBe('1');
    expect(raw).toContain('recovered');
  });
});
