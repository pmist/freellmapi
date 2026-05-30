import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { routeRequest, routeDynamicRequest, recordRateLimitHit, recordSuccess, type RouteResult } from '../services/router.js';
import { recordRequest, recordTokens, setCooldown } from '../services/ratelimit.js';
import { getDb, getUnifiedApiKey } from '../db/index.js';

export const proxyRouter = Router();

// Sticky sessions: track which model served each "session"
// Key: hash of first user message → model_db_id
// This prevents model switching mid-conversation which causes hallucination
const stickySessionMap = new Map<string, { modelDbId: number; lastUsed: number }>();
const STICKY_TTL_MS = 30 * 60 * 1000; // 30 min session TTL

function getSessionKey(messages: ChatMessage[]): string {
  // Use the first user message as session identifier
  // Hermes sends the full conversation each time, so first user msg is stable
  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser) return '';
  // Extract text from content (handle string or array content parts)
  const contentStr = extractMessageText(firstUser.content);
  if (!contentStr) return '';
  // Hash: first 100 chars of first user message + message count
  return `${contentStr.slice(0, 100)}:${messages.length > 2 ? 'multi' : 'single'}`;
}

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

function getStickyModel(messages: ChatMessage[]): number | undefined {
  // Only apply sticky for multi-turn (has assistant messages = continuation)
  const hasAssistant = messages.some(m => m.role === 'assistant');
  if (!hasAssistant) return undefined;

  const key = getSessionKey(messages);
  if (!key) return undefined;

  const entry = stickySessionMap.get(key);
  if (!entry) return undefined;

  if (Date.now() - entry.lastUsed > STICKY_TTL_MS) {
    stickySessionMap.delete(key);
    return undefined;
  }
  return entry.modelDbId;
}

function setStickyModel(messages: ChatMessage[], modelDbId: number) {
  const key = getSessionKey(messages);
  if (!key) return;
  stickySessionMap.set(key, { modelDbId, lastUsed: Date.now() });

  // Cleanup old entries
  if (stickySessionMap.size > 500) {
    const now = Date.now();
    for (const [k, v] of stickySessionMap) {
      if (now - v.lastUsed > STICKY_TTL_MS) stickySessionMap.delete(k);
    }
  }
}

// OpenAI-compatible /v1/models endpoint
// Returns models in OpenAI format: https://developers.openai.com/api/reference/resources/models/methods/list
proxyRouter.get('/models', (_req: Request, res: Response) => {
  const db = getDb();
  const models = db.prepare('SELECT platform, model_id, display_name, context_window FROM models WHERE enabled = 1 ORDER BY intelligence_rank').all() as any[];
  // Use a base timestamp (Jan 1 2026) so models sort chronologically by intelligence rank
  const baseCreated = 1767225600; // 2026-01-01T00:00:00Z
  res.json({
    object: 'list',
    data: models.map((m, idx) => ({
      id: m.model_id,
      object: 'model',
      created: baseCreated + idx, // incremental so ordering can be inferred
      owned_by: m.platform,
      // Extra fields (backwards-compatible additions)
      name: m.display_name,
      context_window: m.context_window,
    })),
  });
});

const MAX_RETRIES = 20;

// ── OpenAI-Compatible Content Parts (for multimodal / user messages) ──
const textContentPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const imageUrlContentPartSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string(),
    detail: z.string().optional(),
  }),
});

const contentPartSchema = z.union([textContentPartSchema, imageUrlContentPartSchema]);

// ── Message Schemas (OpenAI-compatible) ──

const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string(),
  }),
});

const systemMessageSchema = z.object({
  role: z.literal('system'),
  content: z.union([z.string(), z.array(contentPartSchema)]),
  name: z.string().optional(),
});

const userMessageSchema = z.object({
  role: z.literal('user'),
  content: z.union([z.string(), z.array(contentPartSchema)]),
  name: z.string().optional(),
});

const assistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.string().nullable().optional(),
  name: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
}).refine((msg) => {
  // OpenAI allows null/empty content as long as tool_calls is present
  // or just an empty assistant message (rare, but valid)
  const hasContent = typeof msg.content === 'string';
  const hasToolCalls = (msg.tool_calls?.length ?? 0) > 0;
  return hasContent || hasToolCalls || msg.content === null || msg.content === undefined;
}, {
  message: 'assistant messages must include content or tool_calls',
});

const toolMessageSchema = z.object({
  role: z.literal('tool'),
  content: z.string(),
  tool_call_id: z.string().min(1),
  name: z.string().optional(),
});

const toolDefinitionSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
});

const toolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string().min(1),
    }),
  }),
]);

const chatCompletionSchema = z.object({
  messages: z.array(z.union([
    systemMessageSchema,
    userMessageSchema,
    assistantMessageSchema,
    toolMessageSchema,
  ])).min(1),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  seed: z.number().int().optional(),
  user: z.string().optional(),
  tools: z.array(toolDefinitionSchema).optional(),
  tool_choice: toolChoiceSchema.optional(),
  parallel_tool_calls: z.boolean().optional(),
});

function isRetryableError(err: any): boolean {
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')
    || msg.includes('quota') || msg.includes('resource_exhausted')
    || msg.includes('aborted') || msg.includes('timeout') || msg.includes('etimedout')
    || msg.includes('econnrefused') || msg.includes('econnreset')
    || msg.includes('503') || msg.includes('unavailable')
    || msg.includes('500') || msg.includes('internal server error');
}

proxyRouter.post('/chat/completions', async (req: Request, res: Response) => {
  const start = Date.now();

  // Authenticate with unified API key (skip for local requests)
  const authHeader = req.headers.authorization;
  const isLocal = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
  if (authHeader && !isLocal) {
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const unifiedKey = getUnifiedApiKey();
    if (token !== unifiedKey) {
      res.status(401).json({
        error: {
          message: 'Incorrect API key provided. You can find your API key at the settings page.',
          type: 'invalid_request_error',
          param: null,
          code: 'invalid_api_key',
        },
      });
      return;
    }
  }

  // Validate request
  const parsed = chatCompletionSchema.safeParse(req.body);
  if (!parsed.success) {
    // Format validation errors with param info for OpenAI-compatible clients
    const firstError = parsed.error.errors[0];
    const errorPath = firstError?.path?.join('.') ?? null;
    res.status(400).json({
      error: {
        message: `Invalid request: ${firstError?.message ?? 'Unknown validation error'}` +
          (parsed.error.errors.length > 1 ? ` (+${parsed.error.errors.length - 1} more issues)` : ''),
        type: 'invalid_request_error',
        param: errorPath,
        code: 'invalid_request_error',
      },
    });
    return;
  }

  const { temperature, max_tokens, top_p, stream, stop, frequency_penalty, presence_penalty, seed, user, tools, tool_choice, parallel_tool_calls } = parsed.data;
  const messages: ChatMessage[] = parsed.data.messages.map((m): ChatMessage => {
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content ?? null,
        ...(m.name ? { name: m.name } : {}),
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      };
    }

    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: m.content,
        tool_call_id: m.tool_call_id,
        ...(m.name ? { name: m.name } : {}),
      };
    }

    return {
      role: m.role,
      content: m.content as string | null | Array<Record<string, unknown>>,
      ...(m.name ? { name: m.name } : {}),
    };
  });

  const estimatedInputTokens = messages.reduce((sum, m) => {
    const text = extractMessageText(m.content);
    return sum + Math.ceil(text.length / 4);
  }, 0);
  const estimatedTotal = estimatedInputTokens + (max_tokens ?? 1000);

  // Find requested model if specified
  let requestedModelDbId: number | undefined;
  let dynamicPlatform: string | undefined;
  let dynamicModelId: string | undefined;

  if (parsed.data.model) {
    const db = getDb();
    const reqModel = parsed.data.model;

    // First, try to match the exact model string as model_id (e.g. 'anthropic/claude-3-opus' might be a model_id under openrouter)
    const exactRow = db.prepare('SELECT id FROM models WHERE model_id = ?').get(reqModel) as { id: number } | undefined;
    
    if (exactRow) {
      requestedModelDbId = exactRow.id;
    } else {
      // If exact match fails, try parsing as platform/model_id
      const slashIdx = reqModel.indexOf('/');
      if (slashIdx !== -1) {
        const platform = reqModel.slice(0, slashIdx);
        const modelId = reqModel.slice(slashIdx + 1);
        const row = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(platform, modelId) as { id: number } | undefined;
        if (row) {
          requestedModelDbId = row.id;
        } else {
          dynamicPlatform = platform;
          dynamicModelId = modelId;
        }
      }
    }
  }

  // Sticky session: prefer the same model for multi-turn conversations
  // User's requested model takes precedence over sticky session
  const preferredModel = requestedModelDbId ?? getStickyModel(messages);

  // Retry loop: on 429/rate limit, skip that model+key and try the next one
  const skipKeys = new Set<string>();
  let lastError: any = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      if (dynamicPlatform && dynamicModelId) {
        route = routeDynamicRequest(dynamicPlatform, dynamicModelId, estimatedTotal, skipKeys.size > 0 ? skipKeys : undefined);
      } else {
        route = routeRequest(estimatedTotal, skipKeys.size > 0 ? skipKeys : undefined, preferredModel);
      }
    } catch (err: any) {
      // No more models available
      if (lastError) {
        res.status(429).json({
          error: {
            message: `All models rate-limited. Last error: ${lastError.message}`,
            type: 'rate_limit_error',
            param: null,
            code: 'rate_limit_error',
          },
        });
      } else {
        res.status(err.status ?? 503).json({
          error: {
            message: err.message,
            type: err.status === 400 ? 'invalid_request_error' : 'server_error',
            param: null,
            code: 'service_unavailable',
          },
        });
      }
      return;
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      if (stream) {
        // Streaming - start the provider FIRST to catch errors before sending headers
        let gen: AsyncGenerator<any>;
        try {
          gen = route.provider.streamChatCompletion(
            route.apiKey, messages, route.modelId,
            { temperature, max_tokens, top_p, stop, frequency_penalty, presence_penalty, seed, user, tools, tool_choice, parallel_tool_calls },
          );
        } catch (providerErr: any) {
          // Provider rejected before streaming started - can retry
          const latency = Date.now() - start;
          logRequest(route.platform, route.modelId, 'error', estimatedInputTokens, 0, latency, providerErr.message);
          const isOpencode = route.platform === 'opencode';
          const shouldRetry = isOpencode || isRetryableError(providerErr);
          if (shouldRetry) {
            const skipId = `${route.platform}:${route.modelId}:${route.keyId}`;
            skipKeys.add(skipId);
            const cooldownMs = isOpencode ? 8 * 60 * 60 * 1000 : 120_000;
            setCooldown(route.platform, route.modelId, route.keyId, cooldownMs);
            recordRateLimitHit(route.modelDbId);
            lastError = providerErr;
            console.log(`[Proxy] ${providerErr.message.slice(0, 60)} from ${route.displayName}, falling back (attempt ${attempt + 1}/${MAX_RETRIES})`);
            continue;
          }
          // Non-retryable - send JSON error (no SSE headers set yet)
          res.status(502).json({
            error: {
              message: `Provider error (${route.displayName}): ${providerErr.message}`,
              type: 'server_error',
              param: null,
              code: 'provider_error',
            },
          });
          return;
        }

        // Stream started successfully - NOW set SSE headers and stream
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
        if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));

        let totalOutputTokens = 0;
        try {
          for await (const chunk of gen) {
            const text = chunk.choices[0]?.delta?.content ?? '';
            totalOutputTokens += Math.ceil(text.length / 4);
            if (parsed.data.model) {
              chunk.model = parsed.data.model;
            }
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
        } catch (streamErr: any) {
          // Mid-stream error - end gracefully with SSE error event
          console.log(`[Proxy] Stream error from ${route.displayName}: ${streamErr.message.slice(0, 60)}`);
          res.write(`data: ${JSON.stringify({ error: { message: `Stream error: ${streamErr.message}`, type: 'stream_error' } })}\n\n`);
        }

        res.write('data: [DONE]\n\n');
        res.end();

        recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + totalOutputTokens);
        recordSuccess(route.modelDbId);
        setStickyModel(messages, route.modelDbId);
        logRequest(route.platform, route.modelId, 'success', estimatedInputTokens, totalOutputTokens, Date.now() - start, null);
        return;
      } else {
        const result = await route.provider.chatCompletion(
          route.apiKey, messages, route.modelId,
          { temperature, max_tokens, top_p, stop, frequency_penalty, presence_penalty, seed, user, tools, tool_choice, parallel_tool_calls },
        );

        if (parsed.data.model) {
          result.model = parsed.data.model;
        }

        const totalTokens = result.usage?.total_tokens ?? 0;
        recordTokens(route.platform, route.modelId, route.keyId, totalTokens);
        recordSuccess(route.modelDbId);
        setStickyModel(messages, route.modelDbId);

        res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
        if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
        res.json(result);

        logRequest(
          route.platform, route.modelId, 'success',
          result.usage?.prompt_tokens ?? 0,
          result.usage?.completion_tokens ?? 0,
          Date.now() - start, null,
        );
        return;
      }
    } catch (err: any) {
      const latency = Date.now() - start;
      logRequest(route.platform, route.modelId, 'error', estimatedInputTokens, 0, latency, err.message);

      const isOpencode = route.platform === 'opencode';
      const shouldRetry = isOpencode || isRetryableError(err);

      if (shouldRetry) {
        // Put this model+key on cooldown and try the next one
        const skipId = `${route.platform}:${route.modelId}:${route.keyId}`;
        skipKeys.add(skipId);
        
        // OpenCode models get an 8-hour cooldown on ANY error, others get 2 minutes on retryable errors
        const cooldownMs = isOpencode ? 8 * 60 * 60 * 1000 : 120_000;
        setCooldown(route.platform, route.modelId, route.keyId, cooldownMs);
        
        recordRateLimitHit(route.modelDbId);
        lastError = err;
        console.log(`[Proxy] ${err.message.slice(0, 60)} from ${route.displayName}, falling back (attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      // Non-retryable error (auth, 4xx, etc.): don't retry
      res.status(502).json({
        error: {
          message: `Provider error (${route.displayName}): ${err.message}`,
          type: 'server_error',
          param: null,
          code: 'provider_error',
        },
      });
      return;
    }
  }

  // Exhausted all retries
  res.status(429).json({
    error: {
      message: `All models rate-limited after ${MAX_RETRIES} attempts. Last: ${lastError?.message}`,
      type: 'rate_limit_error',
      param: null,
      code: 'rate_limit_error',
    },
  });
});

function logRequest(
  platform: string,
  modelId: string,
  status: string,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
  error: string | null,
) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(platform, modelId, status, inputTokens, outputTokens, latencyMs, error);
  } catch (e) {
    console.error('Failed to log request:', e);
  }
}
