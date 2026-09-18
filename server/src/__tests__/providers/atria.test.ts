import { describe, it, expect, vi } from 'vitest';
import { getProvider } from '../../providers/index.js';

describe('Atria AI provider', () => {
  it('is registered with the expected platform and name', () => {
    const provider = getProvider('atria');
    expect(provider).toBeDefined();
    expect(provider!.platform).toBe('atria');
    expect(provider!.name).toBe('Atria AI');
  });

  it('sends OpenAI-compatible Chat Completions requests to the Atria endpoint', async () => {
    const provider = getProvider('atria')!;

    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = url as string;
      capturedHeaders = (init as any).headers;
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'chatcmpl-atria',
          object: 'chat.completion',
          created: 1,
          model: 'Atria-Dawn-Preview',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      } as any;
    });

    const result = await provider.chatCompletion(
      'atr_test',
      [{ role: 'user', content: 'hi' }],
      'Atria-Dawn-Preview',
      { seed: 42 },
    );

    expect(capturedUrl).toBe('https://api.atria-asi.ai/v1/chat/completions');
    expect(capturedHeaders['Authorization']).toBe('Bearer atr_test');
    expect(capturedBody.model).toBe('Atria-Dawn-Preview');
    expect(capturedBody.seed).toBeUndefined();
    expect(result._routed_via?.platform).toBe('atria');
  });
});
