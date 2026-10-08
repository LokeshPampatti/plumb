import type { Usage } from '../types.js';

export interface LLMRequest {
  /** Stable text (instructions, repo conventions). Cached where the provider supports it. */
  system: string;
  /** Stable per-review context shared by every call in one review. Cached too. */
  sharedContext?: string;
  /** The part that changes per call. */
  prompt: string;
  /** JSON Schema for the response object. */
  schema: Record<string, unknown>;
  maxTokens?: number;
  /** Label for logs and usage accounting. */
  purpose: 'find' | 'verify' | 'summarize' | 'chat';
}

export interface LLMResponse {
  json: unknown;
  raw: string;
  usage: Usage;
}

export interface Provider {
  readonly name: string;
  readonly model: string;
  /** USD per million tokens; 0 for local or subscription-backed providers. */
  readonly pricing: { input: number; output: number; cacheRead: number; cacheWrite: number };
  complete(req: LLMRequest): Promise<LLMResponse>;
}

/** Rough token count. Good enough for budgeting; we round up. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0, calls: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    usd: a.usd + b.usd,
    calls: a.calls + b.calls,
  };
}

export class BudgetExceeded extends Error {
  constructor(
    readonly spent: number,
    readonly budget: number,
  ) {
    super(`Budget of $${budget.toFixed(2)} reached ($${spent.toFixed(3)} spent). Raise budgetUsd or pass --budget.`);
  }
}

/** One spend cap shared by every provider in a review, including calls still in flight. */
export class Budget {
  spent = 0;
  private reserved = 0;
  constructor(readonly cap: number) {}
  reserve(usd: number): void {
    if (usd > 0 && this.spent + this.reserved + usd > this.cap) throw new BudgetExceeded(this.spent, this.cap);
    this.reserved += usd;
  }
  settle(reservedUsd: number, actualUsd: number): void {
    this.reserved = Math.max(0, this.reserved - reservedUsd);
    this.spent += actualUsd;
  }
}

/** Wraps a provider and refuses calls that would push spend past the shared cap. */
export class MeteredProvider implements Provider {
  usage: Usage = emptyUsage();
  constructor(
    private inner: Provider,
    private budget: Budget,
    private log: (msg: string) => void = () => {},
  ) {}
  get name() {
    return this.inner.name;
  }
  get model() {
    return this.inner.model;
  }
  get pricing() {
    return this.inner.pricing;
  }
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const projected =
      (approxTokens(req.system + (req.sharedContext ?? '') + req.prompt) * this.pricing.input + (req.maxTokens ?? 4000) * 0.35 * this.pricing.output) / 1e6;
    this.budget.reserve(projected);
    const t0 = Date.now();
    let res: LLMResponse;
    try {
      res = await this.inner.complete(req);
    } catch (e) {
      this.budget.settle(projected, 0);
      throw e;
    }
    this.budget.settle(projected, res.usage.usd);
    this.usage = addUsage(this.usage, res.usage);
    this.log(`${req.purpose}: ${res.usage.inputTokens} in / ${res.usage.outputTokens} out, ${((Date.now() - t0) / 1000).toFixed(1)}s, $${res.usage.usd.toFixed(4)}`);
    return res;
  }
}

/** Pull the first JSON object or array out of model text (for providers without native structured output). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.search(/[[{]/);
    if (start < 0) continue;
    const open = c[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) {
        if (ch === '\\') i++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        try {
          return JSON.parse(c.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  throw new Error('Model response did not contain valid JSON');
}
