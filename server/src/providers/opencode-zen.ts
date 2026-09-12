import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolCall,
  Platform,
} from '@freellmapi/shared/types.js';
import { BaseProvider, type CompletionOptions } from './base.js';

/** Safely extract text from a message content field (string, null, or content part array) */
function extractMessageText(content: string | null | Array<Record<string, unknown>>): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(p => (typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

function safeParseObject(raw: string): Record<string, unknown> {
  try { const p = JSON.parse(raw); return p && typeof p === 'object' && !Array.isArray(p) ? p as Record<string, unknown> : { value: p }; }
  catch { return { value: raw }; }
}

function mapAnthropicStopReason(reason?: string): 'tool_calls' | 'length' | 'stop' {
  if (reason === 'tool_use') return 'tool_calls';
  if (reason === 'max_tokens') return 'length';
  return 'stop';
}

/** Translate OpenAI messages to Anthropic Messages API shape (system separated out). */
function toAnthropicMessages(messages: ChatMessage[]): { system?: string; messages: any[] } {
  const systemText = messages
    .filter(m => m.role === 'system')
    .map(m => extractMessageText(m.content))
    .filter(t => t.length > 0)
    .join('\n\n');

  const out: any[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;

    if (m.role === 'assistant') {
      const blocks: any[] = [];
      const text = extractMessageText(m.content);
      if (text.length > 0) blocks.push({ type: 'text', text });
      for (const tc of m.tool_calls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: safeParseObject(tc.function.arguments),
        });
      }
      out.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: m.tool_call_id,
          content: extractMessageText(m.content),
        }],
      });
    } else {
      out.push({ role: 'user', content: extractMessageText(m.content) });
    }
  }

  return { system: systemText.length > 0 ? systemText : undefined, messages: out };
}

/** Translate OpenAI messages to Gemini `contents` + `systemInstruction`. */
function toGeminiContents(messages: ChatMessage[]): { contents: any[]; systemInstruction?: any } {
  const systemText = messages
    .filter(m => m.role === 'system')
    .map(m => extractMessageText(m.content))
    .filter(t => t.length > 0)
    .join('\n\n');

  const toolNameByCallId = new Map<string, string>();
  for (const m of messages) {
    for (const tc of m.tool_calls ?? []) {
      toolNameByCallId.set(tc.id, tc.function.name);
    }
  }

  const contents: any[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;

    if (m.role === 'assistant') {
      const parts: any[] = [];
      const text = extractMessageText(m.content);
      if (text.length > 0) parts.push({ text });
      for (const tc of m.tool_calls ?? []) {
        parts.push({
          functionCall: {
            id: tc.id,
            name: tc.function.name,
            args: safeParseObject(tc.function.arguments),
          },
        });
      }
      if (parts.length > 0) contents.push({ role: 'model', parts });
    } else if (m.role === 'tool') {
      const name = m.name ?? (m.tool_call_id ? toolNameByCallId.get(m.tool_call_id) : undefined) ?? 'tool';
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            id: m.tool_call_id,
            name,
            response: safeParseObject(extractMessageText(m.content)),
          },
        }],
      });
    } else {
      contents.push({ role: 'user', parts: [{ text: extractMessageText(m.content) }] });
    }
  }

  return {
    contents,
    systemInstruction: systemText.length > 0 ? { parts: [{ text: systemText }] } : undefined,
  };
}

function extractGeminiText(parts: any[]): string {
  return parts.map(p => (typeof p.text === 'string' ? p.text : '')).join('');
}

function extractGeminiToolCalls(parts: any[]): ChatToolCall[] {
  const calls: ChatToolCall[] = [];
  for (const part of parts) {
    if (!part.functionCall?.name) continue;
    const id = part.functionCall.id ?? `call_${Date.now()}_${calls.length}`;
    calls.push({
      index: calls.length,
      id,
      type: 'function',
      function: {
        name: part.functionCall.name,
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      },
    });
  }
  return calls;
}

/** Translate OpenAI messages to the Responses API `input` items + `instructions`. */
function toResponsesInput(messages: ChatMessage[]): { instructions?: string; input: any[] } {
  const instructions = messages
    .filter(m => m.role === 'system')
    .map(m => extractMessageText(m.content))
    .filter(t => t.length > 0)
    .join('\n\n');

  const input: any[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;

    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output: extractMessageText(m.content),
      });
      continue;
    }

    if (m.role === 'assistant') {
      const text = extractMessageText(m.content);
      if (text.length > 0) input.push({ type: 'message', role: 'assistant', content: text });
      for (const tc of m.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        });
      }
      continue;
    }

    input.push({ type: 'message', role: 'user', content: extractMessageText(m.content) });
  }

  return { instructions: instructions.length > 0 ? instructions : undefined, input };
}

/** Responses API tools are flat: `{type:'function', name, description, parameters}`. */
function toResponsesTools(tools?: any[]): any {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(t => {
    const fn = t.function ?? t;
    const out: Record<string, unknown> = {
      type: 'function',
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters,
    };
    if (fn.strict !== undefined) out.strict = fn.strict;
    return out;
  });
}

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

function toAnthropicToolChoice(toolChoice?: any): any {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'none') return { type: 'none' };
    if (toolChoice === 'required') return { type: 'any' };
    return { type: 'auto' };
  }
  return { type: 'tool', name: toolChoice.function.name };
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
      stop: options?.stop,
      frequency_penalty: options?.frequency_penalty,
      presence_penalty: options?.presence_penalty,
      seed: options?.seed,
      user: options?.user,
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

    const rawData = await res.json() as any;
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
    const { instructions, input } = toResponsesInput(messages);

    const reqBody: Record<string, unknown> = {
      model: modelId,
      input,
      ...(instructions ? { instructions } : {}),
      temperature: options?.temperature,
      max_output_tokens: options?.max_tokens,
      top_p: options?.top_p,
      seed: options?.seed,
      user: options?.user,
      tools: toResponsesTools(options?.tools),
      tool_choice: options?.tool_choice,
      parallel_tool_calls: options?.parallel_tool_calls,
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
    const { system, messages: anthropicMessages } = toAnthropicMessages(messages);

    const reqBody: Record<string, unknown> = {
      model: modelId,
      ...(system ? { system } : {}),
      messages: anthropicMessages,
      max_tokens: options?.max_tokens || 4096,
      temperature: options?.temperature,
      top_p: options?.top_p,
      stop_sequences: options?.stop ? (Array.isArray(options.stop) ? options.stop : [options.stop]) : undefined,
      tools: toAnthropicTools(options?.tools),
      tool_choice: toAnthropicToolChoice(options?.tool_choice),
      ...(options?.user ? { metadata: { user_id: options.user } } : {}),
    };

    const res = await this.fetchWithTimeout(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
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
    const { contents, systemInstruction } = toGeminiContents(messages);

    const reqBody: Record<string, unknown> = {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      generationConfig: {
        temperature: options?.temperature,
        maxOutputTokens: options?.max_tokens,
        topP: options?.top_p,
        stopSequences: options?.stop ? (Array.isArray(options.stop) ? options.stop : [options.stop]) : undefined,
      },
      tools: toGeminiTools(options?.tools),
      ...(options?.user ? { user: options.user } : {}),
    };

    const res = await this.fetchWithTimeout(`${this.baseUrl}/models/${modelId}:generateContent`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
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
    const textParts: string[] = [];
    const toolCalls: ChatToolCall[] = [];

    for (const item of data.output ?? []) {
      if (item.type === 'message') {
        for (const part of item.content ?? []) {
          if (part.type === 'output_text' && typeof part.text === 'string') {
            textParts.push(part.text);
          }
        }
      } else if (item.type === 'function_call') {
        toolCalls.push({
          index: toolCalls.length,
          id: item.call_id,
          type: 'function',
          function: { name: item.name, arguments: item.arguments ?? '{}' },
        });
      }
    }

    const text = textParts.join('');
    const finish_reason = toolCalls.length > 0
      ? 'tool_calls'
      : (data.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'stop');

    return {
      id: data.id || `zen-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: text.length > 0 ? text : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason,
      }],
      usage: {
        prompt_tokens: data.usage?.input_tokens || 0,
        completion_tokens: data.usage?.output_tokens || 0,
        total_tokens: data.usage?.total_tokens ?? ((data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)),
      },
      _routed_via: { platform: this.platform, model: modelId },
    };
  }

  private transformMessagesToChatCompletion(data: any, modelId: string): ChatCompletionResponse {
    const textParts: string[] = [];
    const toolCalls: ChatToolCall[] = [];

    for (const block of data.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          index: toolCalls.length,
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
      }
    }

    const text = textParts.join('');

    return {
      id: data.id || `zen-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: text.length > 0 ? text : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: mapAnthropicStopReason(data.stop_reason),
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
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const text = extractGeminiText(parts);
    const toolCalls = extractGeminiToolCalls(parts);

    return {
      id: data.name || `zen-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: text.length > 0 ? text : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      }],
      usage: {
        prompt_tokens: data.usageMetadata?.promptTokenCount || 0,
        completion_tokens: data.usageMetadata?.candidatesTokenCount || 0,
        total_tokens: data.usageMetadata?.totalTokenCount ?? ((data.usageMetadata?.promptTokenCount || 0) + (data.usageMetadata?.candidatesTokenCount || 0)),
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
            content: typeof response.choices[0].message.content === 'string' ? response.choices[0].message.content : undefined,
            ...(response.choices[0].message.tool_calls ? { tool_calls: response.choices[0].message.tool_calls } : {}),
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
            content: typeof response.choices[0].message.content === 'string' ? response.choices[0].message.content : undefined,
            ...(response.choices[0].message.tool_calls ? { tool_calls: response.choices[0].message.tool_calls } : {}),
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
    const { system, messages: anthropicMessages } = toAnthropicMessages(messages);

    const res = await this.fetchWithTimeout(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: modelId,
        ...(system ? { system } : {}),
        messages: anthropicMessages,
        max_tokens: options?.max_tokens || 4096,
        temperature: options?.temperature,
        top_p: options?.top_p,
        stop_sequences: options?.stop ? (Array.isArray(options.stop) ? options.stop : [options.stop]) : undefined,
        tools: toAnthropicTools(options?.tools),
        tool_choice: toAnthropicToolChoice(options?.tool_choice),
        ...(options?.user ? { metadata: { user_id: options.user } } : {}),
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
    const id = `zen-${Date.now()}`;
    let buffer = '';

    const makeChunk = (
      delta: ChatCompletionChunk['choices'][0]['delta'],
      finish_reason: string | null = null,
    ): ChatCompletionChunk => ({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{ index: 0, delta, finish_reason }],
    });

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

          if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
            yield makeChunk({
              role: 'assistant',
              tool_calls: [{
                index: parsed.index,
                id: parsed.content_block.id,
                type: 'function',
                function: { name: parsed.content_block.name, arguments: '' },
              }],
            });
          } else if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
            yield makeChunk({ role: 'assistant', content: parsed.delta.text });
          } else if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'input_json_delta') {
            yield makeChunk({
              role: 'assistant',
              tool_calls: [{
                index: parsed.index,
                function: { arguments: parsed.delta.partial_json },
              } as unknown as ChatToolCall],
            });
          } else if (parsed.type === 'message_delta') {
            yield makeChunk({}, mapAnthropicStopReason(parsed.delta?.stop_reason));
          } else if (parsed.type === 'message_stop') {
            return;
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

  async getModels(apiKey: string): Promise<Array<{ id: string; name: string }>> {
    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
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
