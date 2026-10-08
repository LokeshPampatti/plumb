// Non-Anthropic-API backends: any OpenAI-compatible server (OpenAI, Ollama,
// LM Studio, vLLM, OpenRouter), the local Claude Code CLI (uses the user's
// Claude subscription, no API key), and a deterministic mock for tests.

import { spawn } from 'node:child_process';
import type { LLMRequest, LLMResponse, Provider } from './provider.js';
import { approxTokens, extractJson } from './provider.js';

export class OpenAICompatibleProvider implements Provider {
  readonly pricing: Provider['pricing'];
  constructor(
    readonly name: 'openai' | 'ollama',
    readonly model: string,
    private baseUrl: string,
    private apiKey?: string,
    price?: { input: number; output: number },
  ) {
    const p = price ?? (name === 'ollama' ? { input: 0, output: 0 } : { input: 2.5, output: 10 });
    this.pricing = { input: p.input, output: p.output, cacheRead: p.input / 4, cacheWrite: p.input };
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: req.system + (req.sharedContext ? '\n\n' + req.sharedContext : '') },
        { role: 'user', content: req.prompt + '\n\nRespond with JSON only, matching this schema:\n' + JSON.stringify(req.schema) },
      ],
      response_format: this.name === 'ollama' ? { type: 'json_object' } : { type: 'json_schema', json_schema: { name: 'result', schema: req.schema, strict: false } },
    };
    if (this.name === 'ollama') body.options = { temperature: 0.1, num_ctx: 32768 };
    const res = await fetch(this.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${this.name} error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { choices: { message: { content: string } }[]; usage?: { prompt_tokens: number; completion_tokens: number } };
    const raw = data.choices?.[0]?.message?.content ?? '';
    const inT = data.usage?.prompt_tokens ?? approxTokens(JSON.stringify(body.messages));
    const outT = data.usage?.completion_tokens ?? approxTokens(raw);
    return {
      json: extractJson(raw),
      raw,
      usage: { inputTokens: inT, outputTokens: outT, cacheReadTokens: 0, cacheWriteTokens: 0, usd: (inT * this.pricing.input + outT * this.pricing.output) / 1e6, calls: 1 },
    };
  }
}

/** Runs `claude -p` headless with no tools. Billing goes to the user's Claude plan, not an API key. */
export class ClaudeCodeProvider implements Provider {
  readonly name = 'claude-code';
  readonly pricing = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  constructor(
    readonly model: string = 'opus',
    private bin = 'claude',
    private timeoutMs = 10 * 60_000,
  ) {}

  complete(req: LLMRequest): Promise<LLMResponse> {
    const args = [
      '-p',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(req.schema),
      '--system-prompt',
      req.system + (req.sharedContext ? '\n\n' + req.sharedContext : ''),
      '--tools',
      '',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--model',
      this.model,
    ];
    return new Promise((resolve, reject) => {
      // Strip API credentials so this path can only ever bill the user's Claude plan.
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      const child = spawn(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`claude did not answer within ${Math.round(this.timeoutMs / 60000)} minutes`));
      }, this.timeoutMs);
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => reject(new Error(`Could not start \`${this.bin}\`: ${e.message}. Install Claude Code or pick another provider.`)));
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`claude exited ${code}: ${(err || out).slice(0, 400)}`));
        try {
          const envl = JSON.parse(out) as { result?: string; structured_output?: unknown; is_error?: boolean; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
          if (envl.is_error) {
            const msg = String(envl.result);
            if (/not logged in|\/login/i.test(msg)) return reject(new Error('Claude Code is not signed in. Run `claude auth login --claudeai` once, then retry.'));
            return reject(new Error(`claude reported an error: ${msg.slice(0, 300)}`));
          }
          const raw = envl.result ?? '';
          const json = envl.structured_output ?? extractJson(raw);
          resolve({
            json,
            raw,
            usage: {
              inputTokens: envl.usage?.input_tokens ?? approxTokens(req.system + req.prompt),
              outputTokens: envl.usage?.output_tokens ?? approxTokens(raw),
              cacheReadTokens: envl.usage?.cache_read_input_tokens ?? 0,
              cacheWriteTokens: envl.usage?.cache_creation_input_tokens ?? 0,
              usd: 0,
              calls: 1,
            },
          });
        } catch (e) {
          reject(e);
        }
      });
      child.stdin.end(req.prompt);
    });
  }
}

/**
 * Deterministic provider for tests and demos. `script` maps a purpose to a
 * function that inspects the prompt and returns the JSON the model "would" return.
 */
export class MockProvider implements Provider {
  readonly name = 'mock';
  readonly model = 'mock';
  readonly pricing = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
  calls: LLMRequest[] = [];
  constructor(private script: Partial<Record<LLMRequest['purpose'], (req: LLMRequest, n: number) => unknown>> = {}) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    const n = this.calls.filter((c) => c.purpose === req.purpose).length;
    const fn = this.script[req.purpose];
    const json = fn ? fn(req, n) : req.purpose === 'find' ? { findings: [] } : req.purpose === 'verify' ? { verdicts: [] } : {};
    const raw = JSON.stringify(json);
    const inT = approxTokens(req.system + (req.sharedContext ?? '') + req.prompt);
    const outT = approxTokens(raw);
    return { json, raw, usage: { inputTokens: inT, outputTokens: outT, cacheReadTokens: 0, cacheWriteTokens: 0, usd: (inT + outT * 5) / 1e6, calls: 1 } };
  }
}
