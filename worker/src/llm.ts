import type { Env } from "./index";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface LlmResult {
  text: string;
  provider: "openrouter" | "workers-ai";
  model: string;
  // Real token counts from the provider's own usage accounting when
  // available (OpenRouter always reports these); null when the provider
  // doesn't report usage (Workers AI), so callers fall back to estimation.
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number;
}

// OpenRouter free-tier Qwen model - editable at runtime via
// RuntimeConfig.llmModelSlug (admin dashboard Settings tab), no redeploy
// needed. OpenRouter's free-tier lineup shifts over time (models get
// deprecated/promoted to paid-only) - if this slug 404s, check
// https://openrouter.ai/models?max_price=0 for a current one.
export const DEFAULT_OPENROUTER_MODEL = "qwen/qwen3-235b-a22b:free";
const WORKERS_AI_GENERATION_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

// USD per 1M tokens, keyed by OpenRouter model slug. Used as a fallback cost
// calculation when OpenRouter's own usage.cost field isn't present on the
// response (it's an opt-in "usage accounting" field, not always returned).
// Add a model's slug here to get accurate costing instead of $0.
const MODEL_PRICING_PER_MILLION: Record<string, { in: number; out: number }> = {
  "openai/gpt-4o-mini": { in: 0.15, out: 0.6 },
};

function estimateCostFromPricing(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING_PER_MILLION[model];
  if (!pricing) return 0;
  return (inputTokens / 1_000_000) * pricing.in + (outputTokens / 1_000_000) * pricing.out;
}

async function callOpenRouter(
  messages: ChatMessage[],
  maxTokens: number,
  apiKey: string,
  model: string
): Promise<{ text: string; inputTokens: number | null; outputTokens: number | null; costUsd: number }> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, usage: { include: true } }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(`OpenRouter chat completion failed (${response.status}): ${bodyText}`);
  }

  const body = (await response.json()) as {
    choices: { message: { content: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  };
  const content = body.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenRouter chat completion returned no content");
  }

  const inputTokens = body.usage?.prompt_tokens ?? null;
  const outputTokens = body.usage?.completion_tokens ?? null;
  const costUsd =
    body.usage?.cost ??
    (inputTokens !== null && outputTokens !== null ? estimateCostFromPricing(model, inputTokens, outputTokens) : 0);

  return { text: content, inputTokens, outputTokens, costUsd };
}

async function callWorkersAi(messages: ChatMessage[], maxTokens: number, ai: Ai): Promise<string> {
  const response = await ai.run(WORKERS_AI_GENERATION_MODEL, { messages, max_tokens: maxTokens });
  return (response as { response: string }).response;
}

/**
 * Single entry point for chat generation. Routes to OpenRouter or Workers AI
 * based on config.llmProvider so the provider can be flipped at runtime
 * (admin Settings tab) without a redeploy. Callers should let failures
 * propagate - falling back silently would hide a bad model slug or an
 * OpenRouter outage and quietly shift cost/quality without anyone noticing.
 */
export async function generateChatCompletion(
  messages: ChatMessage[],
  maxTokens: number,
  env: Env,
  config: { llmProvider: "openrouter" | "workers-ai"; llmModelSlug: string }
): Promise<LlmResult> {
  if (config.llmProvider === "openrouter") {
    const model = config.llmModelSlug || DEFAULT_OPENROUTER_MODEL;
    const result = await callOpenRouter(messages, maxTokens, env.OPENROUTER_API_KEY, model);
    return {
      text: result.text,
      provider: "openrouter",
      model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
    };
  }

  const text = await callWorkersAi(messages, maxTokens, env.AI);
  return {
    text,
    provider: "workers-ai",
    model: WORKERS_AI_GENERATION_MODEL,
    inputTokens: null,
    outputTokens: null,
    costUsd: 0,
  };
}
