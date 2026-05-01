import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  Platform,
} from '@freellmapi/shared/types.js';
import { BaseProvider, type CompletionOptions } from './base.js';

type ZenEndpointType = 'chat' | 'responses' | 'messages' | 'gemini';

interface ZenModelInfo {
  endpoint: ZenEndpointType;
  modelId: string;
}

function sanitizeSchema(schema: any): any {
  if (Array.isArray(schema)) {
    return schema.map(sanitizeSchema);
  } else if (schema !== null && typeof schema === 'object') {
    const newObj: any = {};
    const allowedKeys = ['type', 'format', 'description', 'nullable', 'enum', 'items', 'properties', 'required'];
    for (const key of Object.keys(schema)) {
      if (allowedKeys.includes(key)) {
        if (key === 'properties' && schema.properties && typeof schema.properties === 'object') {
          const props: any = {};
          for (const propName of Object.keys(schema.properties)) {
            props[propName] = sanitizeSchema(schema.properties[propName]);
          }
          newObj.properties = props;
        } else {
          newObj[key] = sanitizeSchema(schema[key]);
        }
      }
    }
    return newObj;
  }
  return schema;
}

function toGeminiTools(tools?: any[]): any {
  if (!tools || tools.length === 0) return undefined;
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      parameters: sanitizeSchema(t.function.parameters),
    })),
  }];
}

function toAnthropicTools(tools?: any[]): any {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

export class OpenCodeZenProvider extends BaseProvider {
  readonly platform = 'opencode' as const;
  readonly name = 'OpenCode Zen';

  private readonly baseUrl = 'https://opencode.ai/zen/v1';

  private readonly modelEndpoints: Record<string, ZenModelInfo> = {
    // GPT models - Responses API
    'gpt-5.5': { endpoint: 'responses', modelId: 'gpt-5.5' },
    'gpt-5.5-pro': { endpoint: 'responses', modelId: 'gpt-5.5-pro' },
    'gpt-5.4': { endpoint: 'responses', modelId: 'gpt-5.4' },
    'gpt-5.4-pro': { endpoint: 'responses', modelId: 'gpt-5.4-pro' },
    'gpt-5.4-mini': { endpoint: 'responses', modelId: 'gpt-5.4-mini' },
    'gpt-5.4-nano': { endpoint: 'responses', modelId: 'gpt-5.4-nano' },
    'gpt-5.3-codex': { endpoint: 'responses', modelId: 'gpt-5.3-codex' },
    'gpt-5.3-codex-spark': { endpoint: 'responses', modelId: 'gpt-5.3-codex-spark' },
    'gpt-5.2': { endpoint: 'responses', modelId: 'gpt-5.2' },
    'gpt-5.2-codex': { endpoint: 'responses', modelId: 'gpt-5.2-codex' },
    'gpt-5.1': { endpoint: 'responses', modelId: 'gpt-5.1' },
    'gpt-5.1-codex': { endpoint: 'responses', modelId: 'gpt-5.1-codex' },
    'gpt-5.1-codex-max': { endpoint: 'responses', modelId: 'gpt-5.1-codex-max' },
    'gpt-5.1-codex-mini': { endpoint: 'responses', modelId: 'gpt-5.1-codex-mini' },
    'gpt-5': { endpoint: 'responses', modelId: 'gpt-5' },
    'gpt-5-codex': { endpoint: 'responses', modelId: 'gpt-5-codex' },
    'gpt-5-nano': { endpoint: 'responses', modelId: 'gpt-5-nano' },

    // Claude models - Messages API
    'claude-opus-4-7': { endpoint: 'messages', modelId: 'claude-opus-4-7' },
    'claude-opus-4-6': { endpoint: 'messages', modelId: 'claude-opus-4-6' },
    'claude-opus-4-5': { endpoint: 'messages', modelId: 'claude-opus-4-5' },
    'claude-opus-4-1': { endpoint: 'messages', modelId: 'claude-opus-4-1' },
    'claude-sonnet-4-6': { endpoint: 'messages', modelId: 'claude-sonnet-4-6' },
    'claude-sonnet-4-5': { endpoint: 'messages', modelId: 'claude-sonnet-4-5' },
    'claude-sonnet-4': { endpoint: 'messages', modelId: 'claude-sonnet-4' },
    'claude-haiku-4-5': { endpoint: 'messages', modelId: 'claude-haiku-4-5' },
    'claude-3-5-haiku': { endpoint: 'messages', modelId: 'claude-3-5-haiku' },

    // Gemini models - Gemini API
    'gemini-3.1-pro': { endpoint: 'gemini', modelId: 'gemini-3.1-pro' },
    'gemini-3-flash': { endpoint: 'gemini', modelId: 'gemini-3-flash' },

    // OpenAI-compatible models
    'qwen3.6-plus': { endpoint: 'chat', modelId: 'qwen3.6-plus' },
    'qwen3.5-plus': { endpoint: 'chat', modelId: 'qwen3.5-plus' },
    'minimax-m2.7': { endpoint: 'chat', modelId: 'minimax-m2.7' },
    'minimax-m2.5': { endpoint: 'chat', modelId: 'minimax-m2.5' },
    'minimax-m2.5-free': { endpoint: 'chat', modelId: 'minimax-m2.5-free' },
    'glm-5.1': { endpoint: 'chat', modelId: 'glm-5.1' },
    'glm-5': { endpoint: 'chat', modelId: 'glm-5' },
    'kimi-k2.5': { endpoint: 'chat', modelId: 'kimi-k2.5' },
    'kimi-k2.6': { endpoint: 'chat', modelId: 'kimi-k2.6' },
    'big-pickle': { endpoint: 'chat', modelId: 'big-pickle' },
    'ling-2.6-flash': { endpoint: 'chat', modelId: 'ling-2.6-flash' },
    'hy3-preview-free': { endpoint: 'chat', modelId: 'hy3-preview-free' },
    'nemotron-3-super-free': { endpoint: 'chat', modelId: 'nemotron-3-super-free' },
  };

  private getModelInfo(modelId: string): ZenModelInfo {
    const info = this.modelEndpoints[modelId];
    if (!info) {
      return { endpoint: 'chat', modelId };
    }
    return info;
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const { endpoint, modelId: zenModelId } = this.getModelInfo(modelId);

    if (endpoint === 'chat') {
      return this.chatCompletionOpenAI(apiKey, messages, zenModelId, options);
    } else if (endpoint === 'responses') {
      return this.chatCompletionResponses(apiKey, messages, zenModelId, options);
    } else if (endpoint === 'messages') {
      return this.chatCompletionMessages(apiKey, messages, zenModelId, options);
    } else if (endpoint === 'gemini') {
      return this.chatCompletionGemini(apiKey, messages, zenModelId, options);
    }

    throw new Error(`Unsupported endpoint type: ${endpoint}`);
  }

  private async chatCompletionOpenAI(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const reqBody = {
      model: modelId,
      messages,
      temperature: options?.temperature,
      max_tokens: options?.max_tokens,
      top_p: options?.top_p,
      tools: options?.tools,
      tool_choice: options?.tool_choice,
      parallel_tool_calls: options?.parallel_tool_calls,
    };

    const res = await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(reqBody),
    }, 30000);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`OpenCode Zen API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const rawData = await res.json();
    const data = { ...rawData } as ChatCompletionResponse;
    data._routed_via = { platform: this.platform, model: modelId };
    data._request_response = {
      provider_request: reqBody,
      provider_response: rawData,
    };
    return data;
  }

  private async chatCompletionResponses(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const reqBody = {
      model: modelId,
      input: messages,
      temperature: options?.temperature,
      max_output_tokens: options?.max_tokens,
      top_p: options?.top_p,
      tools: options?.tools,
      tool_choice: options?.tool_choice,
    };

    const res = await this.fetchWithTimeout(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(reqBody),
    }, 30000);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`OpenCode Zen Responses API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const data = await res.json();
    const result = this.transformResponsesToChatCompletion(data, modelId);
    result._request_response = {
      provider_request: reqBody,
      provider_response: data,
    };
    return result;
  }

  private async chatCompletionMessages(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const anthropicMessages = messages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content || '',
    }));

    const reqBody = {
      model: modelId,
      messages: anthropicMessages,
      max_tokens: options?.max_tokens || 4096,
      temperature: options?.temperature,
      top_p: options?.top_p,
      tools: toAnthropicTools(options?.tools),
    };

    const res = await this.fetchWithTimeout(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(reqBody),
    }, 30000);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`OpenCode Zen Messages API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const data = await res.json();
    const result = this.transformMessagesToChatCompletion(data, modelId);
    result._request_response = {
      provider_request: reqBody,
      provider_response: data,
    };
    return result;
  }

  private async chatCompletionGemini(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const reqBody = {
      contents: messages.map(m => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.content || '' }],
      })),
      generationConfig: {
        temperature: options?.temperature,
        maxOutputTokens: options?.max_tokens,
        topP: options?.top_p,
      },
      tools: toGeminiTools(options?.tools),
    };

    const res = await this.fetchWithTimeout(`${this.baseUrl}/models/${modelId}:generateContent`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(reqBody),
    }, 30000);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`OpenCode Zen Gemini API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const data = await res.json();
    const result = this.transformGeminiToChatCompletion(data, modelId);
    result._request_response = {
      provider_request: reqBody,
      provider_response: data,
    };
    return result;
  }

  private transformResponsesToChatCompletion(data: any, modelId: string): ChatCompletionResponse {
    const text = data.output?.text || data.output?.message?.content || '';
    return {
      id: data.id || `zen-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: text,
        },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: data.usage?.input_tokens || 0,
        completion_tokens: data.usage?.output_tokens || 0,
        total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
      },
      _routed_via: { platform: this.platform, model: modelId },
    };
  }

  private transformMessagesToChatCompletion(data: any, modelId: string): ChatCompletionResponse {
    const text = data.content?.[0]?.text || '';
    return {
      id: data.id || `zen-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: text,
        },
        finish_reason: data.stop_reason || 'stop',
      }],
      usage: {
        prompt_tokens: data.usage?.input_tokens || 0,
        completion_tokens: data.usage?.output_tokens || 0,
        total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
      },
      _routed_via: { platform: this.platform, model: modelId },
    };
  }

  private transformGeminiToChatCompletion(data: any, modelId: string): ChatCompletionResponse {
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return {
      id: data.name || `zen-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: text,
        },
        finish_reason: data.candidates?.[0]?.finishReason?.toLowerCase() || 'stop',
      }],
      usage: {
        prompt_tokens: data.usageMetadata?.promptTokenCount || 0,
        completion_tokens: data.usageMetadata?.candidatesTokenCount || 0,
        total_tokens: (data.usageMetadata?.promptTokenCount || 0) + (data.usageMetadata?.candidatesTokenCount || 0),
      },
      _routed_via: { platform: this.platform, model: modelId },
    };
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const { endpoint, modelId: zenModelId } = this.getModelInfo(modelId);

    if (endpoint === 'chat') {
      yield* this.streamChatOpenAI(apiKey, messages, zenModelId, options);
    } else if (endpoint === 'responses') {
      const response = await this.chatCompletionResponses(apiKey, messages, zenModelId, options);
      yield {
        id: response.id,
        object: 'chat.completion.chunk',
        created: response.created,
        model: response.model,
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            content: response.choices[0].message.content ?? undefined,
          },
          finish_reason: response.choices[0].finish_reason,
        }],
      };
    } else if (endpoint === 'messages') {
      yield* this.streamMessages(apiKey, messages, zenModelId, options);
    } else if (endpoint === 'gemini') {
      const response = await this.chatCompletionGemini(apiKey, messages, zenModelId, options);
      yield {
        id: response.id,
        object: 'chat.completion.chunk',
        created: response.created,
        model: response.model,
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            content: response.choices[0].message.content ?? undefined,
          },
          finish_reason: response.choices[0].finish_reason,
        }],
      };
    }
  }

  private async *streamChatOpenAI(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
        stream: true,
      }),
    }, 30000);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`OpenCode Zen API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
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

  private async *streamMessages(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const anthropicMessages = messages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content || '',
    }));

    const res = await this.fetchWithTimeout(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: modelId,
        messages: anthropicMessages,
        max_tokens: options?.max_tokens || 4096,
        temperature: options?.temperature,
        top_p: options?.top_p,
        tools: toAnthropicTools(options?.tools),
        stream: true,
      }),
    }, 30000);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`OpenCode Zen Messages API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
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
        if (data === '[DONE]' || data === '') continue;
        try {
          const parsed = JSON.parse(data);
          const text = parsed.delta?.text || parsed.content_block?.delta?.text || '';
          if (text) {
            yield {
              id: parsed.message || `zen-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [{
                index: 0,
                delta: { role: 'assistant', content: text },
                finish_reason: null,
              }],
            };
          }
        } catch {
          // Skip malformed chunks
        }
      }
    }
  }

  async validateKey(apiKey: string): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
      }, 10000);
      return res.status !== 401 && res.status !== 403;
    } catch {
      return false;
    }
  }
}
