// Runs Plumb on the 50 bug-introducing PRs from Greptile's public benchmark
// (https://www.greptile.com/benchmarks) and scores it the same way: a bug counts
// as caught only if a line-level finding identifies it and explains the impact.
//
//   npx tsx bench/run.ts --static                    # $0, deterministic checks only
//   npx tsx bench/run.ts --provider claude-code      # uses your Claude plan, no API key
//   npx tsx bench/run.ts --provider anthropic --budget 30 --yes
//   npx tsx bench/run.ts --cases sentry-1,keycloak-1 --static
//
// Each case shallow-fetches exactly two commits (base and head) of the public fork,
// so the full run needs a few GB of disk, not the repos' whole history.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPTHS, type PlumbConfig, type ProviderName } from '../src/config.js';
import { makeProvider } from '../src/llm/factory.js';
import type { Provider } from '../src/llm/provider.js';
import { keywords } from '../src/memory.js';
import { runReview, type ReviewResult } from '../src/review/pipeline.js';
import type { Finding } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));

interface Case {
  id: string;
  repo: string;
  lang: string;
  pr: number;
  title: string;
  bug: string;
  severity: string;
  caughtBy: string[];
  base: string;
  head: string;
  mergeBase?: string;
}

interface CaseResult {
  id: string;
  bug: string;
  caught: boolean;
  how: 'static' | 'model' | null;
  matched?: { title: string; file: string; line: number; verification: string };
  judge: 'llm' | 'keyword';
  judgeReason?: string;
  findings: number;
  findingTitles: string[];
  usd: number;
  seconds: number;
  error?: string;
  others: string[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024 });
}

function checkout(work: string, c: Case): string {
  const dir = join(work, c.repo.split('/')[1]);
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    sh(dir, 'init', '-q');
    sh(dir, 'remote', 'add', 'origin', `https://github.com/${c.repo}.git`);
    sh(dir, 'config', 'core.autocrlf', 'false');
  }
  for (const sha of [c.mergeBase ?? c.base, c.head]) {
    const have = (() => {
      try {
        sh(dir, 'cat-file', '-e', `${sha}^{commit}`);
        return true;
      } catch {
        return false;
      }
    })();
    if (!have) sh(dir, 'fetch', '-q', '--depth=1', '--filter=blob:none', 'origin', sha);
  }
  try {
    sh(dir, 'checkout', '-q', '-f', '--detach', c.head);
  } catch {
    // Lazy blob downloads in partial clones fail now and then; refetch and retry once.
    sh(dir, 'fetch', '-q', '--depth=1', '--filter=blob:none', 'origin', c.head);
    sh(dir, 'checkout', '-q', '-f', '--detach', c.head);
  }
  sh(dir, 'clean', '-qfdx', '-e', '.plumb');
  return dir;
}

/** Keyword overlap judge: free, used for static-only runs. Conservative by design. */
function keywordJudge(c: Case, findings: Finding[]): { idx: number; reason: string } | null {
  const want = new Set([...keywords(c.bug, 12), ...(c.bug.match(/[A-Za-z_][A-Za-z0-9_.]{4,}/g) ?? []).map((w) => w.toLowerCase())]);
  let best = -1;
  let bestScore = 0;
  findings.forEach((f, i) => {
    const hay = `${f.title} ${f.body}`.toLowerCase();
    const score = [...want].filter((w) => hay.includes(w)).length;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return bestScore >= 2 ? { idx: best, reason: `${bestScore} key terms overlap` } : null;
}

const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['caught', 'index', 'reason'],
  properties: { caught: { type: 'boolean' }, index: { type: 'integer' }, reason: { type: 'string' } },
};

async function llmJudge(judge: Provider, c: Case, findings: Finding[]): Promise<{ idx: number; reason: string } | null> {
  if (!findings.length) return null;
  const list = findings.map((f, i) => `#${i} ${f.file}:${f.line} [${f.severity}] ${f.title}\n${f.body}`).join('\n\n');
  const r = await judge.complete({
    system:
      'You grade AI code review benchmarks. A known bug was planted in a pull request. Decide whether any review finding identifies that specific bug: same root cause, pointing at the code that has it, and explaining its impact. A finding about a different problem does not count, even if it is real.',
    prompt: `Known bug: ${c.bug}\nPull request: ${c.title}\n\nReview findings:\n${list}\n\nReturn caught=true with the index of the matching finding, or caught=false with index -1.`,
    schema: JUDGE_SCHEMA,
    purpose: 'chat',
    maxTokens: 4000,
  });
  const j = r.json as { caught: boolean; index: number; reason: string };
  return j.caught && findings[j.index] ? { idx: j.index, reason: j.reason } : null;
}

async function main() {
  const data = JSON.parse(readFileSync(join(here, 'dataset.json'), 'utf8')) as { cases: Case[] };
  const only = arg('cases')?.split(',');
  const repoFilter = arg('repo');
  const cases = data.cases.filter((c) => (!only || only.includes(c.id)) && (!repoFilter || c.id.startsWith(repoFilter)));
  const work = arg('workdir') ?? join(homedir(), '.cache', 'plumb-bench');
  mkdirSync(work, { recursive: true });

  const staticOnly = flag('static');
  const provider = (arg('provider') ?? 'none') as ProviderName;
  const depth = arg('depth') as keyof typeof DEPTHS | undefined;
  if (depth && !DEPTHS[depth]) {
    console.error(`--depth must be one of ${Object.keys(DEPTHS).join(', ')}`);
    process.exit(1);
  }
  const preset = depth ? DEPTHS[depth] : undefined;
  const model: PlumbConfig['model'] = { provider, name: arg('model'), effort: (arg('effort') as PlumbConfig['model']['effort']) ?? preset?.effort ?? 'high' };
  const budget = Number(arg('budget') ?? '1');
  if (!staticOnly && provider !== 'none' && provider !== 'claude-code' && provider !== 'ollama' && provider !== 'exchange' && !flag('yes')) {
    console.error(`This run calls ${provider} for ${cases.length} cases with a $${budget.toFixed(2)} cap per case. Re-run with --yes to confirm.`);
    process.exit(1);
  }
  const judgeProvider = !staticOnly && provider !== 'none' ? makeProvider({ ...model, name: arg('judge-model') ?? model.name }) : null;

  const results: CaseResult[] = [];
  const outDir = join(here, 'results');
  mkdirSync(outDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, '-');
  const mode = staticOnly ? 'static' : `${provider}/${model.name ?? 'default'}${depth ? `/${depth}` : ''}`;
  for (const c of cases) {
    const t0 = Date.now();
    process.stderr.write(`\n[${c.id}] ${c.title}\n  bug: ${c.bug}\n`);
    let r: ReviewResult | null = null;
    let error: string | undefined;
    try {
      const dir = checkout(work, c);
      r = await runReview({
        cwd: dir,
        // GitHub diffs a PR from the merge-base (three-dot), not from the base branch tip.
        mode: { kind: 'range', from: c.mergeBase ?? c.base, to: c.head, worktreeIsHead: true },
        staticOnly,
        config: { model, budgetUsd: budget, strictness: 2, ...(preset ? { votes: preset.votes, specialists: preset.specialists, verify: preset.verify } : {}) },
        confirmSpend: async () => true,
        prDescription: c.title,
        saveState: false,
        log: flag('verbose') ? (m) => process.stderr.write(`  · ${m}\n`) : undefined,
      });
    } catch (e) {
      error = (e as Error).message.slice(0, 300);
    }
    const findings = r?.findings ?? [];
    let verdict: { idx: number; reason: string } | null = null;
    let judgeKind: CaseResult['judge'] = 'keyword';
    if (findings.length) {
      if (judgeProvider) {
        judgeKind = 'llm';
        try {
          verdict = await llmJudge(judgeProvider, c, findings);
        } catch (e) {
          judgeKind = 'keyword';
          verdict = keywordJudge(c, findings);
        }
      } else verdict = keywordJudge(c, findings);
    }
    const m = verdict ? findings[verdict.idx] : undefined;
    const res: CaseResult = {
      id: c.id,
      bug: c.bug,
      caught: !!m,
      how: m ? (m.source === 'static' ? 'static' : 'model') : null,
      matched: m ? { title: m.title, file: m.file, line: m.line, verification: m.verification } : undefined,
      judge: judgeKind,
      judgeReason: verdict?.reason,
      findings: findings.length,
      findingTitles: findings.map((f) => `[${f.severity}] ${f.file}:${f.line} ${f.title}`),
      usd: r?.usage.usd ?? 0,
      seconds: Math.round((Date.now() - t0) / 100) / 10,
      error,
      others: c.caughtBy,
    };
    results.push(res);
    // Save after every case so a stopped run keeps what it finished.
    writeFileSync(join(outDir, `${stamp}.json`), JSON.stringify({ summary: { at: startedAt, mode, partial: true }, results }, null, 1));
    process.stderr.write(`  ${res.caught ? 'CAUGHT' : 'missed'} · ${res.findings} findings · $${res.usd.toFixed(3)} · ${res.seconds}s${error ? ` · ERROR ${error}` : ''}\n`);
    if (m) process.stderr.write(`  ↳ ${m.file}:${m.line} ${m.title}\n`);
  }

  const n = results.length;
  const caught = results.filter((r) => r.caught).length;
  const tools = ['greptile', 'cursor', 'copilot', 'coderabbit', 'graphite'];
  const summary = {
    at: startedAt,
    mode,
    cases: n,
    plumb: { caught, rate: n ? caught / n : 0, staticCatches: results.filter((r) => r.how === 'static').length, avgFindings: n ? results.reduce((a, r) => a + r.findings, 0) / n : 0, usd: results.reduce((a, r) => a + r.usd, 0), seconds: results.reduce((a, r) => a + r.seconds, 0) },
    others: Object.fromEntries(tools.map((t) => [t, cases.filter((c) => c.caughtBy.includes(t)).length])),
    caughtByPlumbOnly: results.filter((r) => r.caught && !r.others.includes('greptile')).map((r) => r.id),
  };
  writeFileSync(join(outDir, `${stamp}.json`), JSON.stringify({ summary, results }, null, 1));

  const md: string[] = [
    `# Plumb on Greptile's benchmark (${summary.mode})`,
    '',
    `${caught}/${n} bugs caught (${Math.round(summary.plumb.rate * 100)}%), ${summary.plumb.staticCatches} of them by $0 static analysis. Avg ${summary.plumb.avgFindings.toFixed(1)} findings per PR, $${summary.plumb.usd.toFixed(2)} total.`,
    '',
    `On the same ${n} case(s), Greptile's table credits: ${tools.map((t) => `${t} ${summary.others[t]}`).join(', ')}.`,
    '',
    '| Case | Bug | Plumb | How | Greptile |',
    '|---|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.bug} | ${r.caught ? '✅' : '—'} | ${r.how ?? ''} | ${r.others.includes('greptile') ? '✅' : '—'} |`),
  ];
  writeFileSync(join(outDir, `${stamp}.md`), md.join('\n') + '\n');
  console.log(md.join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
