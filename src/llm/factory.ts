import type { PlumbConfig } from '../config.js';
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from './anthropic.js';
import { ClaudeCodeProvider, ExchangeProvider, OpenAICompatibleProvider } from './others.js';
import type { Provider } from './provider.js';

export function makeProvider(cfg: PlumbConfig['model'], which: 'finder' | 'verifier' = 'finder'): Provider | null {
  const model = which === 'verifier' && cfg.verifier ? cfg.verifier : cfg.name;
  switch (cfg.provider) {
    case 'none':
    case 'mock':
      return null;
    case 'anthropic':
      return new AnthropicProvider(model ?? DEFAULT_ANTHROPIC_MODEL, cfg.effort ?? 'high', { baseURL: cfg.baseUrl });
    case 'claude-code':
      return new ClaudeCodeProvider(model ?? 'opus');
    case 'exchange':
      return new ExchangeProvider(cfg.baseUrl ?? process.env.PLUMB_EXCHANGE_DIR ?? '.plumb/exchange', model ?? 'agent');
    case 'openai':
      return new OpenAICompatibleProvider('openai', model ?? 'gpt-5', cfg.baseUrl ?? 'https://api.openai.com/v1', process.env.OPENAI_API_KEY);
    case 'ollama':
      return new OpenAICompatibleProvider('ollama', model ?? 'qwen2.5-coder:14b', cfg.baseUrl ?? 'http://localhost:11434/v1');
  }
}

/** Pick a provider from the environment when the config doesn't name one. */
export function detectProvider(): PlumbConfig['model']['provider'] {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'none';
}
