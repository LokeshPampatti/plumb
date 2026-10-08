import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import picomatch from 'picomatch';
import type { Snapshot } from './git.js';
import type { Category, Severity } from './types.js';

export type ProviderName = 'anthropic' | 'openai' | 'ollama' | 'claude-code' | 'mock' | 'none';

export interface PlumbConfig {
  model: {
    provider: ProviderName;
    name?: string;
    /** Model used for the skeptic pass. Defaults to `name`. */
    verifier?: string;
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    baseUrl?: string;
  };
  /** 1 = verbose, 2 = balanced (default), 3 = critical only */
  strictness: 1 | 2 | 3;
  categories: Category[];
  ignore: string[];
  rules: string[];
  verify: boolean;
  /** Independent finder samples; findings must appear in a majority. */
  votes: number;
  /** Hard cap on model spend per review, in USD. 0 = no paid calls. */
  budgetUsd: number;
  autoApprove: { enabled: boolean; maxRisk: 'low' | 'medium' | 'high'; excludePaths: string[]; includePaths: string[] };
  sensitivePaths: string[];
  excludeAuthors: string[];
  reviewers: { suggest: boolean; max: number };
  split: { maxFiles: number; maxLines: number };
  context: { ruleFiles: string[]; maxCallers: number };
  failOn: Severity | 'none';
}

export const DEFAULT_CONFIG: PlumbConfig = {
  model: { provider: 'none', effort: 'high' },
  strictness: 2,
  categories: ['logic', 'security', 'contract', 'secret', 'performance', 'concurrency', 'data', 'syntax'],
  ignore: [],
  rules: [],
  verify: true,
  votes: 1,
  budgetUsd: 2,
  autoApprove: { enabled: false, maxRisk: 'low', excludePaths: [], includePaths: [] },
  sensitivePaths: [
    '**/auth/**',
    '**/*auth*.*',
    '**/billing/**',
    '**/payment*/**',
    '**/*payment*.*',
    '**/migrations/**',
    '**/*.sql',
    '**/security/**',
    '**/crypto/**',
    '.github/workflows/**',
    '**/Dockerfile',
    '**/*.tf',
  ],
  excludeAuthors: ['dependabot[bot]', 'renovate[bot]'],
  reviewers: { suggest: true, max: 3 },
  split: { maxFiles: 25, maxLines: 800 },
  context: {
    ruleFiles: ['CLAUDE.md', 'AGENTS.md', '.cursorrules', '.cursor/rules/*.md', '.cursor/rules/*.mdc', '.github/copilot-instructions.md', 'CONTRIBUTING.md', '.greptile/rules.md'],
    maxCallers: 8,
  },
  failOn: 'none',
};

function merge<T>(base: T, over: Partial<T>): T {
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    if (v === undefined) continue;
    const bv = (base as any)[k];
    out[k] = bv && typeof bv === 'object' && !Array.isArray(bv) && v && typeof v === 'object' && !Array.isArray(v) ? merge(bv, v as any) : v;
  }
  return out;
}

function parseJson(text: string, where: string): any {
  try {
    // Allow // comments and trailing commas: config files are written by hand.
    const cleaned = text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Invalid JSON in ${where}: ${(e as Error).message}`);
  }
}

export interface LoadedConfig {
  /** True when reviewing the working tree or index, where the developer's own edits are trusted. */
  local: boolean;
  config: PlumbConfig;
  /** Plain-English rules, each tagged with the directory it applies to. */
  scopedRules: { dir: string; text: string; source: string }[];
  /** Project instruction files Plumb found (CLAUDE.md, AGENTS.md, ...). */
  instructionFiles: { path: string; text: string }[];
  sources: string[];
}

/**
 * Load config. Policy is read from the BASE side of the change so a PR cannot
 * loosen its own review (Greptile reads greptile.json from the source branch).
 */
export function loadConfig(base: Snapshot, head: Snapshot, cliOverrides: Partial<PlumbConfig> = {}): LoadedConfig {
  const sources: string[] = [];
  let config = DEFAULT_CONFIG;

  const globalPath = join(process.env.HOME ?? '', '.config', 'plumb', 'config.json');
  if (existsSync(globalPath)) {
    config = merge(config, parseJson(readFileSync(globalPath, 'utf8'), globalPath));
    sources.push(globalPath);
  }

  // Local reviews (head = working tree) trust the developer's own uncommitted config.
  // Committed changes (branches, PRs, CI) only trust the base side, so a PR can't
  // loosen its own review by adding or editing .plumb/ files or instruction files.
  const local = head.ref === null || head.ref === ':';
  const baseCfg = base.read('.plumb/config.json');
  const rootCfg = baseCfg ?? (local ? head.read('.plumb/config.json') : null);
  if (rootCfg) {
    config = merge(config, parseJson(rootCfg, '.plumb/config.json'));
    sources.push(baseCfg ? '.plumb/config.json (base)' : '.plumb/config.json');
  }
  if (!local && !baseCfg && head.read('.plumb/config.json')) {
    sources.push('ignored .plumb/config.json added by this change (policy comes from the base branch)');
  }
  config = merge(config, cliOverrides);

  const scopedRules: LoadedConfig['scopedRules'] = config.rules.map((text) => ({ dir: '', text, source: 'config' }));
  for (const f of head.files()) {
    if (!f.endsWith('.plumb/rules.md')) continue;
    // Rules come from the base side, so a PR can't add, edit or delete its own rules.
    const text = base.read(f) ?? (local ? head.read(f) : null);
    if (!text) continue;
    const dir = posix.dirname(posix.dirname(f));
    for (const block of text.split(/\n(?=[-*] )/)) {
      const t = block.replace(/^[-*]\s+/, '').trim();
      if (t && !t.startsWith('#')) scopedRules.push({ dir: dir === '.' ? '' : dir, text: t, source: f });
    }
    sources.push(f);
  }

  const instructionFiles: LoadedConfig['instructionFiles'] = [];
  const isInstr = picomatch(config.context.ruleFiles, { dot: true });
  for (const f of head.files()) {
    const name = f.split('/').pop() ?? f;
    if (isInstr(f) || (f.includes('/') && (name === 'CLAUDE.md' || name === 'AGENTS.md'))) {
      const text = base.read(f) ?? (local ? head.read(f) : null);
      if (text && text.length < 40_000) instructionFiles.push({ path: f, text });
    }
  }
  return { local, config, scopedRules, instructionFiles, sources };
}

export function rulesFor(loaded: LoadedConfig, file: string): string[] {
  return loaded.scopedRules.filter((r) => r.dir === '' || file === r.dir || file.startsWith(r.dir + '/')).map((r) => r.text);
}

export const SEVERITY_RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 };

/** Which severities survive at a strictness level. */
export function severityAllowed(sev: Severity, strictness: 1 | 2 | 3): boolean {
  if (strictness === 3) return sev === 'P0' || sev === 'P1';
  return true;
}

export const SAMPLE_CONFIG = `{
  // Which model reviews your code. Providers: anthropic, openai, ollama, claude-code, none (static checks only)
  "model": { "provider": "anthropic", "name": "claude-opus-5-5", "effort": "high" },

  // 1 = flag everything, 2 = balanced, 3 = only P0/P1
  "strictness": 2,

  // Hard spend cap per review. Plumb estimates cost first and stops if over.
  "budgetUsd": 2,

  // Every model finding is re-checked by an independent skeptic pass.
  "verify": true,

  // Plain-English rules (also put them in .plumb/rules.md in any folder)
  "rules": [],

  // Explainable auto-approve. Policy is always read from the base branch.
  "autoApprove": { "enabled": false, "maxRisk": "low", "excludePaths": ["**/migrations/**"] },

  "ignore": ["**/fixtures/**"]
}
`;
