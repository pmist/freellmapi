import type { Platform } from '@freellmapi/shared/types.js';
import type { BaseProvider } from './base.js';
import { GoogleProvider } from './google.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { CohereProvider } from './cohere.js';
import { CloudflareProvider } from './cloudflare.js';
import { HuggingFaceProvider } from './huggingface.js';
import { OpenCodeZenProvider } from './opencode-zen.js';

const providers = new Map<Platform, BaseProvider>();

function register(provider: BaseProvider) {
  providers.set(provider.platform, provider);
}

// Google - unique Gemini API format
register(new GoogleProvider());

// Groq - OpenAI-compatible. Docs: max_completion_tokens is canonical
// (max_tokens deprecated) and messages[].name is rejected with 400.
register(new OpenAICompatProvider({
  platform: 'groq',
  name: 'Groq',
  baseUrl: 'https://api.groq.com/openai/v1',
  maxTokensField: 'max_completion_tokens',
  dropMessageName: true,
}));

// Cerebras - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'cerebras',
  name: 'Cerebras',
  baseUrl: 'https://api.cerebras.ai/v1',
}));

// SambaNova - OpenAI-compatible. Docs use max_completion_tokens.
register(new OpenAICompatProvider({
  platform: 'sambanova',
  name: 'SambaNova',
  baseUrl: 'https://api.sambanova.ai/v1',
  maxTokensField: 'max_completion_tokens',
}));

// NVIDIA NIM - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'nvidia',
  name: 'NVIDIA NIM',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
}));

// Mistral - OpenAI-compatible. Uses `random_seed` (not `seed`) and
// `additionalProperties: false`, so unknown fields are rejected.
register(new OpenAICompatProvider({
  platform: 'mistral',
  name: 'Mistral',
  baseUrl: 'https://api.mistral.ai/v1',
  seedField: 'random_seed',
}));

// OpenRouter - OpenAI-compatible with app-attribution headers.
// `X-OpenRouter-Title` is the current canonical title header (X-Title legacy).
register(new OpenAICompatProvider({
  platform: 'openrouter',
  name: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  extraHeaders: {
    'HTTP-Referer': 'http://localhost:3001',
    'X-OpenRouter-Title': 'FreeLLMAPI',
  },
}));

// GitHub Models - OpenAI-compatible via Azure endpoint
register(new OpenAICompatProvider({
  platform: 'github',
  name: 'GitHub Models',
  baseUrl: 'https://models.inference.ai.azure.com',
}));

// Cohere - OpenAI-compatible via Cohere compatibility endpoint
register(new CohereProvider());

// Cloudflare Workers AI - OpenAI-compatible endpoint (key = "account_id:token")
register(new CloudflareProvider());

// Hugging Face - OpenAI-compatible per-model endpoint
register(new HuggingFaceProvider());

// Zhipu (Z.ai / bigmodel.cn) - OpenAI-compatible. No documented `seed`.
register(new OpenAICompatProvider({
  platform: 'zhipu',
  name: 'Zhipu AI',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  seedField: null,
}));

// Moonshot (Kimi) - OpenAI-compatible. No documented `seed`.
register(new OpenAICompatProvider({
  platform: 'moonshot',
  name: 'Moonshot',
  baseUrl: 'https://api.moonshot.ai/v1',
  seedField: null,
}));

// MiniMax - OpenAI-compatible. Docs recommend max_completion_tokens; no `seed`.
register(new OpenAICompatProvider({
  platform: 'minimax',
  name: 'MiniMax',
  baseUrl: 'https://api.minimax.io/v1',
  maxTokensField: 'max_completion_tokens',
  seedField: null,
}));

// OpenCode Zen - multiple API formats
register(new OpenCodeZenProvider());

// CLōD - OpenAI-compatible. Docs use max_completion_tokens; no `seed`.
register(new OpenAICompatProvider({
  platform: 'clod',
  name: 'CLōD',
  baseUrl: 'https://api.clod.io/v1',
  maxTokensField: 'max_completion_tokens',
  seedField: null,
}));

// DeepSeek - OpenAI-compatible. No documented `seed`.
register(new OpenAICompatProvider({
  platform: 'deepseek',
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  seedField: null,
}));

// Kilo Code (kilo.ai) - OpenAI-compatible gateway
register(new OpenAICompatProvider({
  platform: 'kilocode',
  name: 'Kilo Code',
  baseUrl: 'https://api.kilo.ai/api/gateway',
}));

// Z.AI - OpenAI-compatible (international GLM endpoint). No documented `seed`.
register(new OpenAICompatProvider({
  platform: 'zai',
  name: 'Z.AI',
  baseUrl: 'https://api.z.ai/api/paas/v4',
  seedField: null,
}));

export function getProvider(platform: Platform): BaseProvider | undefined {
  return providers.get(platform);
}

export function getAllProviders(): BaseProvider[] {
  return Array.from(providers.values());
}

export function hasProvider(platform: Platform): boolean {
  return providers.has(platform);
}
