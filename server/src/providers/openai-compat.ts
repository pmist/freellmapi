import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  Platform,
} from '@freellmapi/shared/types.js';
import { BaseProvider, type CompletionOptions } from './base.js';

/** Remove the OpenAI-only per-message `name` field that some providers reject. */
function stripMessageName(message: ChatMessage): ChatMessage {
  const copy: ChatMessage = { ...message };
  delete copy.name;
  return copy;
}

export interface OpenAICompatOptions {
  platform: Platform;
  name: string;
  baseUrl: string;
  extraHeaders?: Record<string, string>;
  /** URL used by validateKey (defaults to `${baseUrl}/models`). */
  validateUrl?: string;
  /** URL used by getModels (defaults to validateUrl, then `${baseUrl}/models`). */
  modelsUrl?: string;
  /** Per-provider HTTP timeout override. Cloud APIs finish in ~15s; locally-hosted
   * inference (llama.cpp / vLLM on CPU) can take 30-120s for long prompts. Default 15000. */
  timeoutMs?: number;
  /**
   * Request field carrying the max output tokens. Providers that follow the newer
   * OpenAI surface document `max_completion_tokens`; others use `max_tokens`.
   */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /** Seed field name. `random_seed` for Mistral; `null` omits seed entirely. */
  seedField?: 'seed' | 'random_seed' | null;
  /** Request fields this provider rejects and that must be dropped. */
  dropParams?: string[];
  /** Drop `messages[].name` (Groq rejects unknown message fields). */
  dropMessageName?: boolean;
}

/**
 * Generic provider for platforms that expose an OpenAI-compatible chat API.
 * Covers: Groq, Cerebras, SambaNova, NVIDIA NIM, Mistral, OpenRouter,
 * GitHub Models, Zhipu, Moonshot, MiniMax, Kilo Code, CLōD, DeepSeek, Z.AI.
 */
export class OpenAICompatProvider extends BaseProvider {
  readonly platform: Platform;
  readonly name: string;
  private readonly baseUrl: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly validateUrl?: string;
  private readonly modelsUrl?: string;
  private readonly timeoutMs: number;
  private readonly maxTokensField: string;
  private readonly seedField: 'seed' | 'random_seed' | null;
  private readonly dropParams: string[];
  private readonly dropMessageName: boolean;

  constructor(opts: OpenAICompatOptions) {
    super();
    this.platform = opts.platform;
    this.name = opts.name;
    this.baseUrl = opts.baseUrl;
    this.extraHeaders = opts.extraHeaders ?? {};
    this.validateUrl = opts.validateUrl;
    this.modelsUrl = opts.modelsUrl;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.maxTokensField = opts.maxTokensField ?? 'max_tokens';
    // undefined => default `seed`; null => provider does not support seed.
    this.seedField = opts.seedField === undefined ? 'seed' : opts.seedField;
    this.dropParams = opts.dropParams ?? [];
    this.dropMessageName = opts.dropMessageName ?? false;
  }

  /**
   * Builds the request body from OpenAI options, applying the per-provider
   * field-name and unsupported-field adaptations declared in the options above.
   */
  private buildBody(
    messages: ChatMessage[],
    modelId: string,
    options: CompletionOptions | undefined,
    stream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: modelId,
      messages: this.dropMessageName ? messages.map(stripMessageName) : messages,
      temperature: options?.temperature,
      top_p: options?.top_p,
      stop: options?.stop,
      frequency_penalty: options?.frequency_penalty,
      presence_penalty: options?.presence_penalty,
      user: options?.user,
      tools: options?.tools,
      tool_choice: options?.tool_choice,
      parallel_tool_calls: options?.parallel_tool_calls,
    };

    body[this.maxTokensField] = options?.max_tokens;

    if (this.seedField && options?.seed !== undefined) {
      body[this.seedField] = options.seed;
    }

    if (stream) body.stream = true;

    for (const key of Object.keys(body)) {
      if (body[key] === undefined) delete body[key];
    }
    for (const key of this.dropParams) delete body[key];

    return body;
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const reqBody = this.buildBody(messages, modelId, options, false);

    const res = await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...this.extraHeaders,
      },
      body: JSON.stringify(reqBody),
    }, this.timeoutMs);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`${this.name} API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const rawData = await res.json() as any;
    const data = { ...rawData } as ChatCompletionResponse;
    data._routed_via = { platform: this.platform, model: modelId };
    data._request_response = {
      provider_request: reqBody,
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
    const reqBody = this.buildBody(messages, modelId, options, true);

    const res = await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...this.extraHeaders,
      },
      body: JSON.stringify(reqBody),
    }, this.timeoutMs);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`${this.name} API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
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

  private getModelsUrl(): string {
    return this.modelsUrl ?? this.validateUrl ?? `${this.baseUrl}/models`;
  }

  async validateKey(apiKey: string): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout(this.getModelsUrl(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          ...this.extraHeaders,
        },
      }, 10000);
      // 401/403 = bad key, anything else (200, 404, etc) = key is valid
      return res.status !== 401 && res.status !== 403;
    } catch {
      return false;
    }
  }

  async getModels(apiKey: string): Promise<Array<{ id: string; name: string }>> {
    try {
      const res = await this.fetchWithTimeout(this.getModelsUrl(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          ...this.extraHeaders,
        },
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
