import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@freellmapi/shared/types.js';
import { BaseProvider, type CompletionOptions } from './base.js';

const API_BASE = 'https://api.cohere.ai/compatibility/v1';

export class CohereProvider extends BaseProvider {
  readonly platform = 'cohere' as const;
  readonly name = 'Cohere';

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    function buildRequest(options?: CompletionOptions): Record<string, unknown> {
      return {
        model: modelId,
        messages,
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        stop: options?.stop,
        frequency_penalty: options?.frequency_penalty,
        presence_penalty: options?.presence_penalty,
        seed: options?.seed,
        user: options?.user,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
      };
    }

    const body = buildRequest(options);

    const res = await this.fetchWithTimeout(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Cohere API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const rawData = await res.json() as any;
    const data = { ...rawData } as ChatCompletionResponse;
    data._routed_via = { platform: 'cohere', model: modelId };
    data._request_response = {
      provider_request: body,
      provider_response: rawData,
    };
    return data;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const body: Record<string, unknown> = {
      model: modelId,
      messages,
      temperature: options?.temperature,
      max_tokens: options?.max_tokens,
      top_p: options?.top_p,
      stop: options?.stop,
      frequency_penalty: options?.frequency_penalty,
      presence_penalty: options?.presence_penalty,
      seed: options?.seed,
      user: options?.user,
      tools: options?.tools,
      tool_choice: options?.tool_choice,
      parallel_tool_calls: options?.parallel_tool_calls,
      stream: true,
    };

    const res = await this.fetchWithTimeout(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Cohere API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;
        try {
          const chunk = JSON.parse(data) as ChatCompletionChunk;
          // Ensure index in tool_calls for OpenAI streaming compatibility
          if (chunk.choices) {
            for (const choice of chunk.choices) {
              if (choice.delta?.tool_calls) {
                choice.delta.tool_calls = choice.delta.tool_calls.map((tc, idx) => ({
                  ...tc,
                  index: tc.index ?? idx,
                }));
              }
            }
          }
          yield chunk;
        } catch {
          // Skip malformed chunks
        }
      }
    }
  }

  async validateKey(apiKey: string): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout(`${API_BASE}/models`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}` },
      }, 10000);
      return res.ok;
    } catch {
      return false;
    }
  }

  async getModels(apiKey: string): Promise<Array<{ id: string; name: string }>> {
    try {
      const res = await this.fetchWithTimeout(`${API_BASE}/models`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}` },
      }, 10000);
      if (!res.ok) return [];
      const data = await res.json() as any;
      if (data && Array.isArray(data.data)) {
        return data.data.map((m: any) => ({ id: m.id, name: m.name || m.id }));
      }
      return [];
    } catch {
      return [];
    }
  }
}
