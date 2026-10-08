import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { LLMRequest, LLMResponse, Provider } from './provider.js';
import { extractJson } from './provider.js';

// USD per million tokens (Anthropic first-party rates, 2026-09).
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
};

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

// Models that accept the server-side refusal fallback in its "default" form.
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  readonly pricing: Provider['pricing'];
  private client: Anthropic;

  constructor(
    readonly model: string = DEFAULT_ANTHROPIC_MODEL,
    private effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' = 'high',
    opts: { apiKey?: string; baseURL?: string } = {},
  ) {
    const p = PRICES[model] ?? PRICES[DEFAULT_ANTHROPIC_MODEL];
    this.pricing = { input: p.input, output: p.output, cacheRead: p.cacheRead, cacheWrite: p.input * 1.25 };
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 3 });
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    // Stable text first so every call in a review hits the prompt cache.
    const system: Anthropic.Beta.BetaTextBlockParam[] = [{ type: 'text', text: req.system }];
    if (req.sharedContext) system.push({ type: 'text', text: req.sharedContext, cache_control: { type: 'ephemeral' } });
    else system[0].cache_control = { type: 'ephemeral' };

    const params: BetaMessageStreamParams = {
      model: this.model,
      max_tokens: req.maxTokens ?? 32000,
      system,
      messages: [{ role: 'user', content: req.prompt }],
      output_config: { effort: this.effort, format: { type: 'json_schema', schema: req.schema } },
    };
    if (FALLBACK_MODELS.has(this.model)) {
      // On a policy decline the API re-runs the request on a fallback model in the same call.
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }

    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await this.client.beta.messages.stream(params).finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new Error('Anthropic rejected the API key. Set ANTHROPIC_API_KEY or run `ant auth login`.');
      if (err instanceof Anthropic.RateLimitError) throw new Error('Anthropic rate limit hit after retries. Try again shortly or lower --votes.');
      if (err instanceof Anthropic.BadRequestError) throw new Error(`Anthropic rejected the request: ${err.message}`);
      if (err instanceof Anthropic.APIError) throw new Error(`Anthropic API error ${err.status}: ${err.message}`);
      throw err;
    }

    if (message.stop_reason === 'refusal') throw new Error(`Model declined this request (${(message as any).stop_details?.category ?? 'no category'}).`);
    const raw = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (message.stop_reason === 'max_tokens') throw new Error('Model output hit max_tokens before finishing the JSON. Lower the batch size.');

    const u = message.usage;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const usd =
      (u.input_tokens * this.pricing.input + u.output_tokens * this.pricing.output + cacheRead * this.pricing.cacheRead + cacheWrite * this.pricing.cacheWrite) / 1e6;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      json = extractJson(raw);
    }
    return {
      json,
      raw,
      usage: { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, usd, calls: 1 },
    };
  }
}
