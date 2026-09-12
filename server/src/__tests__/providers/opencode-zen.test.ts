import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenCodeZenProvider } from '../../providers/opencode-zen.js';

describe('OpenCodeZenProvider', () => {
  let provider: OpenCodeZenProvider;

  beforeEach(() => {
    provider = new OpenCodeZenProvider();
    vi.restoreAllMocks();
  });

  it('should have correct platform and name', () => {
    expect(provider.platform).toBe('opencode');
    expect(provider.name).toBe('OpenCode Zen');
  });

  describe('Anthropic Messages endpoint', () => {
    it('builds tool_use/tool_result blocks, top-level system, and maps tool_use response', async () => {
      let capturedBody: any = null;

      vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
        capturedBody = JSON.parse((init as any).body);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'msg_1',
            content: [
              { type: 'text', text: 'Checking the weather.' },
              { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Karachi' } },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 11, output_tokens: 4 },
          }),
        } as any;
      });

      const result = await provider.chatCompletion(
        'test-key',
        [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Weather?' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Karachi"}' },
            }],
          },
          { role: 'tool', tool_call_id: 'call_1', content: '{"temp":30}' },
        ],
        'claude-opus-4-7',
      );

      // System message is hoisted to top-level `system` and excluded from messages.
      expect(capturedBody.system).toBe('You are helpful');
      expect(capturedBody.messages).toHaveLength(3);

      const assistantMsg = capturedBody.messages.find((m: any) => m.role === 'assistant');
      const toolUse = assistantMsg.content.find((b: any) => b.type === 'tool_use');
      expect(toolUse).toEqual({
        type: 'tool_use',
        id: 'call_1',
        name: 'get_weather',
        input: { city: 'Karachi' },
      });

      const toolResult = capturedBody.messages[2];
      expect(toolResult.role).toBe('user');
      expect(toolResult.content[0]).toEqual({
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: '{"temp":30}',
      });

      expect(result.choices[0].finish_reason).toBe('tool_calls');
      expect(result.choices[0].message.content).toBe('Checking the weather.');
      expect(result.choices[0].message.tool_calls?.[0].id).toBe('call_1');
      expect(result.choices[0].message.tool_calls?.[0].function.name).toBe('get_weather');
      expect(result.choices[0].message.tool_calls?.[0].function.arguments).toBe('{"city":"Karachi"}');
    });
  });

  describe('Gemini endpoint', () => {
    it('uses x-goog-api-key, builds functionResponse, and maps functionCall response', async () => {
      let capturedBody: any = null;
      let capturedHeaders: Record<string, string> = {};

      vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
        capturedHeaders = (init as any).headers;
        capturedBody = JSON.parse((init as any).body);
        return {
          ok: true,
          json: () => Promise.resolve({
            candidates: [{
              content: {
                parts: [{
                  functionCall: { id: 'call_1', name: 'get_weather', args: { city: 'Karachi' } },
                }],
              },
              finishReason: 'STOP',
            }],
            usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
          }),
        } as any;
      });

      const result = await provider.chatCompletion(
        'test-key',
        [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Weather?' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Karachi"}' },
            }],
          },
          { role: 'tool', tool_call_id: 'call_1', content: '{"temp":30}' },
        ],
        'gemini-3-flash',
      );

      expect(capturedHeaders['x-goog-api-key']).toBe('test-key');
      expect(capturedHeaders['Authorization']).toBeUndefined();
      expect(capturedBody.systemInstruction).toEqual({ parts: [{ text: 'You are helpful' }] });

      const toolMsg = capturedBody.contents.find(
        (c: any) => c.parts?.[0]?.functionResponse,
      );
      expect(toolMsg.parts[0].functionResponse).toEqual({
        id: 'call_1',
        name: 'get_weather',
        response: { temp: 30 },
      });

      expect(result.choices[0].finish_reason).toBe('tool_calls');
      expect(result.choices[0].message.tool_calls?.[0].id).toBe('call_1');
      expect(result.choices[0].message.tool_calls?.[0].function.name).toBe('get_weather');
      expect(result.choices[0].message.tool_calls?.[0].function.arguments).toBe('{"city":"Karachi"}');
    });
  });

  describe('Responses endpoint', () => {
    it('sends flat tools and maps function_call output to tool_calls using call_id', async () => {
      let capturedBody: any = null;

      vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
        capturedBody = JSON.parse((init as any).body);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'resp_1',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'Let me check.' }],
              },
              {
                type: 'function_call',
                call_id: 'call_1',
                name: 'get_weather',
                arguments: '{"city":"Karachi"}',
              },
            ],
            incomplete_details: null,
            usage: { input_tokens: 9, output_tokens: 5, total_tokens: 14 },
          }),
        } as any;
      });

      const result = await provider.chatCompletion(
        'test-key',
        [{ role: 'user', content: 'Weather?' }],
        'gpt-5.5',
        {
          tools: [{
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get weather for a city',
              parameters: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
              },
            },
          }],
        },
      );

      // Responses API expects the flat tool shape.
      expect(capturedBody.tools[0].name).toBe('get_weather');
      expect(capturedBody.tools[0].type).toBe('function');
      expect(capturedBody.tools[0].function).toBeUndefined();
      expect(capturedBody.stop).toBeUndefined();

      expect(result.choices[0].finish_reason).toBe('tool_calls');
      expect(result.choices[0].message.content).toBe('Let me check.');
      expect(result.choices[0].message.tool_calls?.[0].id).toBe('call_1');
      expect(result.choices[0].message.tool_calls?.[0].function.name).toBe('get_weather');
      expect(result.choices[0].message.tool_calls?.[0].function.arguments).toBe('{"city":"Karachi"}');
      expect(result.usage.total_tokens).toBe(14);
    });
  });
});
