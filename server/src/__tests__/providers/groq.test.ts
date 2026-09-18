import { describe, it, expect, vi } from 'vitest';
import { getProvider } from '../../providers/index.js';

describe('Groq provider', () => {
  it('is registered with the expected platform and name', () => {
    const provider = getProvider('groq');
    expect(provider).toBeDefined();
    expect(provider!.platform).toBe('groq');
    expect(provider!.name).toBe('Groq');
  });

  it('sends OpenAI-compatible requests using max_completion_tokens and drops messages[].name', async () => {
    const provider = getProvider('groq')!;

    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = url as string;
      capturedHeaders = (init as any).headers;
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          id: 'chatcmpl-groq',
          object: 'chat.completion',
          created: 1,
          model: 'llama-3.3-70b-versatile',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
      } as any;
    });

    const result = await provider.chatCompletion(
      'gsk_test123',
      [{ role: 'user', content: 'Hi', name: 'bob' }],
      'llama-3.3-70b-versatile',
      { max_tokens: 128 },
    );

    expect(capturedUrl).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(capturedHeaders['Authorization']).toBe('Bearer gsk_test123');
    expect(capturedBody.max_completion_tokens).toBe(128);
    expect(capturedBody.max_tokens).toBeUndefined();
    expect(capturedBody.messages[0].name).toBeUndefined();
    expect(result.choices[0].message.content).toBe('Hello!');
    expect(result._routed_via?.platform).toBe('groq');
  });

  it('throws on API error', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: () => Promise.resolve({ error: { message: 'Invalid API key' } }),
    } as any);

    await expect(
      getProvider('groq')!.chatCompletion('bad-key', [{ role: 'user', content: 'Hi' }], 'llama-3.3-70b-versatile')
    ).rejects.toThrow(/Invalid API key/);
  });

  it('validates keys against the models endpoint', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, status: 200 } as any);
    expect(await getProvider('groq')!.validateKey('valid')).toBe(true);

    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: false, status: 401 } as any);
    expect(await getProvider('groq')!.validateKey('invalid')).toBe(false);

    // A 404 (e.g. no /models route) still means the key itself is valid.
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: false, status: 404 } as any);
    expect(await getProvider('groq')!.validateKey('valid')).toBe(true);
  });
});
