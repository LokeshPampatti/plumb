import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import picomatch from 'picomatch';
import { contractFindings } from '../analyzers/contracts.js';
import { evidence, finalize, lineText, type AnalysisContext } from '../analyzers/context.js';
import { analyzeHistory, type HistoryReport } from '../analyzers/history.js';
import { computeImpact, type Impact } from '../analyzers/impact.js';
import { secretFindings } from '../analyzers/secrets.js';
import { suggestSplit, type SplitPlan } from '../analyzers/split.js';
import { loadConfig, SEVERITY_RANK, type PlumbConfig } from '../config.js';
import { changedLineCount, commentableLines } from '../diff.js';
import { collectChanges, currentBranch, headSha, type DiffMode } from '../git.js';
import { RepoIndex } from '../index/graph.js';
import { DEFAULT_IGNORES } from '../index/languages.js';
import { makeProvider } from '../llm/factory.js';
import { addUsage, approxTokens, Budget, BudgetExceeded, emptyUsage, MeteredProvider, type Provider } from '../llm/provider.js';
import { applyMemory, keywords, loadMemory } from '../memory.js';
import type { Category, CostEstimate, Finding, Severity, Usage } from '../types.js';
import { buildUnits, sharedContext, type ReviewUnit } from './contextpack.js';
import { FINDER_SYSTEM, FINDINGS_SCHEMA, VERDICTS_SCHEMA, VERIFIER_SYSTEM } from './prompts.js';
import { decideGate, scoreReview, type GateDecision, type ScoreReport } from './score.js';

export const VERSION = '0.1.0';

export interface ReviewOptions {
  cwd: string;
  mode: DiffMode;
  config?: Partial<PlumbConfig>;
  /** Inject providers (tests, MCP). `null` forces static-only. */
  provider?: Provider | null;
  verifier?: Provider | null;
  staticOnly?: boolean;
  prDescription?: string;
  instructions?: string;
  /** Stop after the estimate. */
  estimateOnly?: boolean;
  /** Asked before any paid call. Return false to fall back to static-only. */
  confirmSpend?: (est: CostEstimate) => Promise<boolean>;
  paths?: string[];
  log?: (msg: string) => void;
  saveState?: boolean;
  gateContext?: Parameters<typeof decideGate>[4];
}

export interface ReviewResult {
  meta: {
    version: string;
    label: string;
    root: string;
    branch: string;
    baseRef: string;
    headRef: string | null;
    headSha: string;
    startedAt: string;
    durationMs: number;
    provider: string;
    model: string;
    filesChanged: number;
    filesReviewed: number;
    linesAdded: number;
    linesRemoved: number;
    index: RepoIndex['stats'];
    configSources: string[];
  };
  findings: Finding[];
  suppressed: Finding[];
  refuted: Finding[];
  fixed: Finding[];
  impact: Impact;
  history: HistoryReport;
  split: SplitPlan | null;
  score: ScoreReport;
  gate: GateDecision;
  usage: Usage;
  estimate: CostEstimate | null;
  notes: string[];
}

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

interface Candidate {
  file: string;
  line: number;
  endLine?: number;
  severity: Severity;
  category: Category;
  title: string;
  body: string;
  evidence: { file: string; line: number; note: string }[];
  suggestion?: string;
}

function asCandidates(json: unknown): Candidate[] {
  const arr = (json as { findings?: unknown[] })?.findings;
  if (!Array.isArray(arr)) return [];
  return arr.filter((c): c is Candidate => {
    const x = c as Candidate;
    return !!x && typeof x.file === 'string' && Number.isInteger(x.line) && ['P0', 'P1', 'P2'].includes(x.severity) && typeof x.title === 'string';
  });
}

/** Majority vote across independent finder samples. */
function vote(samples: Candidate[][], k: number): Candidate[] {
  if (k <= 1) return samples[0] ?? [];
  const clusters: { rep: Candidate; votes: Set<number> }[] = [];
  samples.forEach((cands, s) => {
    for (const c of cands) {
      const kw = keywords(c.title, 6);
      const hit = clusters.find(
        (cl) =>
          cl.rep.file === c.file &&
          Math.abs(cl.rep.line - c.line) <= 3 &&
          (cl.rep.category === c.category || keywords(cl.rep.title, 6).some((w) => kw.includes(w))),
      );
      if (hit) hit.votes.add(s);
      else clusters.push({ rep: c, votes: new Set([s]) });
    }
  });
  const need = Math.ceil(k / 2);
  return clusters.filter((c) => c.votes.size >= need).map((c) => c.rep);
}

/** Memory follows the same trust rule as config: your own edits locally, the base branch otherwise. */
function memoryText(changes: { oldSnap: { read(p: string): string | null }; newSnap: { read(p: string): string | null } }, local: boolean): string {
  return (local ? changes.newSnap.read('.plumb/memory.json') : null) ?? changes.oldSnap.read('.plumb/memory.json') ?? '';
}

function stateFile(root: string, branch: string): string {
  return join(root, '.plumb', 'state', branch.replace(/[^\w.-]+/g, '_') + '.json');
}

export async function runReview(opts: ReviewOptions): Promise<ReviewResult> {
  const t0 = Date.now();
  const log = opts.log ?? (() => {});
  const notes: string[] = [];

  const changes = collectChanges(opts.cwd, opts.mode);
  const loaded = loadConfig(changes.oldSnap, changes.newSnap, opts.config ?? {});
  const cfg = loaded.config;
  if (opts.instructions) loaded.scopedRules.push({ dir: '', text: opts.instructions, source: 'cli' });

  const isIgnored = picomatch([...DEFAULT_IGNORES, ...cfg.ignore], { dot: true });
  const pathFilter = opts.paths?.length ? picomatch(opts.paths, { dot: true }) : () => true;
  const reviewFiles = new Set(changes.files.filter((f) => !isIgnored(f.path) && pathFilter(f.path)).map((f) => f.path));

  log(`Indexing ${changes.newSnap.files().length} files...`);
  const cacheDir = join(changes.root, '.plumb', 'cache');
  const newIndex = await RepoIndex.build(changes.newSnap, {
    ignore: cfg.ignore,
    cacheDir,
    onProgress: (d, t) => log(`Indexing ${d}/${t}`),
  });
  const oldIndex = await RepoIndex.partial(
    changes.oldSnap,
    changes.files.filter((f) => f.status !== 'added').map((f) => f.oldPath ?? f.path),
  );
  log(`Indexed ${newIndex.stats.files} source files (${newIndex.stats.cached} cached) in ${newIndex.stats.ms}ms`);

  const ctx: AnalysisContext = { changes, newIndex, oldIndex, loaded, reviewFiles };

  // Deterministic layer: free, instant, never hallucinates.
  const staticFindings = [...contractFindings(ctx), ...secretFindings(ctx)].filter((f) => reviewFiles.has(f.file) || f.rule.startsWith('contract/'));
  const impact = computeImpact(ctx);
  const history = analyzeHistory(ctx);
  const split = suggestSplit(ctx);

  // Model layer.
  let provider: Provider | null = opts.staticOnly ? null : opts.provider !== undefined ? opts.provider : makeProvider(cfg.model, 'finder');
  let verifier: Provider | null = opts.staticOnly ? null : opts.verifier !== undefined ? opts.verifier : cfg.model.verifier ? makeProvider(cfg.model, 'verifier') : provider;
  let usage = emptyUsage();
  let estimate: CostEstimate | null = null;
  const llmFindings: Finding[] = [];
  const refuted: Finding[] = [];

  if (provider && reviewFiles.size) {
    const shared = sharedContext(ctx, opts.prDescription);
    const prefs = loadMemory(changes.root, memoryText(changes, loaded.local)).rules.filter((r) => r.kind === 'prefer');
    const sharedFull = shared + (prefs.length ? '\n\n## Team preferences learned from past reviews\n' + prefs.map((p) => `- ${p.text}`).join('\n') : '');
    let units = buildUnits(ctx, impact, history, staticFindings);
    const votes = Math.max(1, Math.min(5, cfg.votes));

    const est = (us: ReviewUnit[]): CostEstimate => {
      const sysT = approxTokens(FINDER_SYSTEM + sharedFull);
      let inT = 0;
      let outT = 0;
      for (const u of us) {
        inT += votes * (sysT + u.tokens + 300);
        outT += votes * 1800;
        if (cfg.verify) {
          inT += approxTokens(VERIFIER_SYSTEM) + approxTokens(sharedFull) + u.tokens + 900;
          outT += 900;
        }
      }
      const p = provider!.pricing;
      // Shared prefix is cached after the first call.
      const cachedShare = Math.max(0, (us.length * (votes + (cfg.verify ? 1 : 0)) - 1) * approxTokens(sharedFull));
      const usd = ((inT - cachedShare) * p.input + cachedShare * p.cacheRead + outT * p.output) / 1e6;
      return {
        provider: provider!.name,
        model: provider!.model,
        inputTokens: inT,
        outputTokens: outT,
        usd: Math.round(usd * 10000) / 10000,
        note: p.input === 0 ? (provider!.name === 'claude-code' ? 'uses your Claude plan, no API charges' : 'local model, no charges') : undefined,
      };
    };

    estimate = est(units);
    if (estimate.usd > cfg.budgetUsd) {
      const before = units.length;
      while (units.length > 1 && est(units).usd > cfg.budgetUsd) units = units.slice(0, -1);
      if (est(units).usd > cfg.budgetUsd) units = [];
      const skipped = before - units.length;
      notes.push(
        units.length
          ? `Budget cap $${cfg.budgetUsd.toFixed(2)}: model review covers the ${units.reduce((n, u) => n + u.files.length, 0)} highest-risk files; ${skipped} batch(es) got static checks only.`
          : `Estimated $${estimate.usd.toFixed(2)} is over the $${cfg.budgetUsd.toFixed(2)} cap, so this run used static checks only. Raise budgetUsd or pass --budget.`,
      );
      estimate = units.length ? est(units) : estimate;
    }

    if (opts.estimateOnly) units = [];
    else if (units.length && estimate.usd > 0 && opts.confirmSpend && !(await opts.confirmSpend(estimate))) {
      notes.push('Paid model review skipped (not confirmed). Static checks still ran.');
      units = [];
    }

    if (units.length) {
      const budget = new Budget(cfg.budgetUsd);
      const metered = new MeteredProvider(provider, budget, log);
      const meteredVerifier = verifier && verifier !== provider ? new MeteredProvider(verifier, budget, log) : metered;
      try {
        await pool(units, 4, async (unit, i) => {
          log(`Reviewing batch ${i + 1}/${units.length}: ${unit.files.map((f) => f.path).join(', ')}`);
          const samples = await Promise.all(
            Array.from({ length: votes }, () =>
              metered
                .complete({ system: FINDER_SYSTEM, sharedContext: sharedFull, prompt: unit.text, schema: FINDINGS_SCHEMA as any, purpose: 'find' })
                .then((r) => asCandidates(r.json))
                .catch((e) => {
                  if (e instanceof BudgetExceeded) throw e;
                  notes.push(`A finder call failed: ${(e as Error).message}`);
                  return [] as Candidate[];
                }),
            ),
          );
          let cands = vote(samples, votes);
          cands = normalize(ctx, unit, cands, staticFindings, notes);
          if (!cands.length) return;

          if (!cfg.verify || !verifier) {
            for (const c of cands) llmFindings.push(toFinding(ctx, c, 'unverified', 0.55));
            return;
          }
          const listing = cands
            .map((c, k) => `#${k} [${c.severity} ${c.category}] ${c.file}:${c.line}: ${c.title}\n${c.body}\nEvidence: ${c.evidence.map((e) => `${e.file}:${e.line} (${e.note})`).join('; ')}`)
            .join('\n\n');
          let verdicts: { index: number; verdict: string; reason: string; severity?: Severity }[] = [];
          try {
            const r = await meteredVerifier.complete({
              system: VERIFIER_SYSTEM,
              sharedContext: sharedFull,
              prompt: `${unit.text}\n\n## Proposed findings to check\n\n${listing}`,
              schema: VERDICTS_SCHEMA as any,
              purpose: 'verify',
            });
            verdicts = ((r.json as { verdicts?: typeof verdicts })?.verdicts ?? []).filter((v) => Number.isInteger(v.index));
          } catch (e) {
            if (e instanceof BudgetExceeded) throw e;
            notes.push(`Verification failed for one batch; its P0/P1 findings are kept and marked unverified: ${(e as Error).message}`);
          }
          cands.forEach((c, k) => {
            const v = verdicts.find((x) => x.index === k);
            if (!v || v.verdict === 'uncertain') {
              // Precision first: uncertain P2s are dropped, uncertain P0/P1s stay but are labelled.
              if (c.severity === 'P2' || cfg.strictness === 3) refuted.push({ ...toFinding(ctx, c, 'refuted', 0.3), verifierNote: v?.reason ?? 'not verified' });
              else llmFindings.push({ ...toFinding(ctx, c, 'unverified', 0.5), verifierNote: v?.reason });
            } else if (v.verdict === 'refuted') {
              refuted.push({ ...toFinding(ctx, c, 'refuted', 0.2), verifierNote: v.reason });
            } else {
              const sev = v.severity && ['P0', 'P1', 'P2'].includes(v.severity) ? v.severity : c.severity;
              llmFindings.push({ ...toFinding(ctx, { ...c, severity: sev }, 'confirmed', 0.85), verifierNote: v.reason });
            }
          });
        });
      } catch (e) {
        if (e instanceof BudgetExceeded) notes.push(e.message + ' Remaining files got static checks only.');
        else throw e;
      }
      usage = addUsage(metered.usage, meteredVerifier !== metered ? (meteredVerifier as MeteredProvider).usage : emptyUsage());
    }
  } else if (!provider && !opts.staticOnly && cfg.model.provider === 'none') {
    notes.push('No model configured: ran static checks only (contracts, secrets, blast radius, history). Run `plumb init` or pass --provider.');
  }

  // Strictness and category filters.
  let findings = [...staticFindings, ...llmFindings].filter((f) => {
    if (f.source === 'static') return true;
    if (!cfg.categories.includes(f.category)) return false;
    if (cfg.strictness === 3 && f.severity === 'P2') return false;
    if (cfg.strictness === 2 && f.severity === 'P2' && f.verification !== 'confirmed') return false;
    return true;
  });

  // Memory: transparent, versioned suppressions.
  const mem = loadMemory(changes.root, memoryText(changes, loaded.local));
  const memOut = applyMemory(mem, findings);
  findings = memOut.kept;
  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);

  // Incremental status vs. the last review of this branch.
  const branch = currentBranch(changes.root);
  const sf = stateFile(changes.root, branch);
  let fixed: Finding[] = [];
  if (existsSync(sf)) {
    try {
      const prev = JSON.parse(readFileSync(sf, 'utf8')) as { findings: Finding[] };
      const prevIds = new Set(prev.findings.map((f) => f.id));
      const nowIds = new Set(findings.map((f) => f.id));
      for (const f of findings) f.status = prevIds.has(f.id) ? 'open' : 'new';
      fixed = prev.findings.filter((f) => !nowIds.has(f.id) && !memOut.suppressed.some((s) => s.id === f.id)).map((f) => ({ ...f, status: 'fixed' as const }));
    } catch {
      // ignore a corrupt state file
    }
  }

  const score = scoreReview(findings, history);
  const gate = decideGate(cfg.autoApprove, score, history, changes.files, opts.gateContext);
  const lines = changedLineCount(changes.files);

  const result: ReviewResult = {
    meta: {
      version: VERSION,
      label: changes.label,
      root: changes.root,
      branch,
      baseRef: changes.baseRef,
      headRef: changes.headRef,
      headSha: headSha(changes.root),
      startedAt: new Date(t0).toISOString(),
      durationMs: Date.now() - t0,
      provider: provider?.name ?? 'none',
      model: provider?.model ?? '-',
      filesChanged: changes.files.length,
      filesReviewed: reviewFiles.size,
      linesAdded: lines.added,
      linesRemoved: lines.removed,
      index: newIndex.stats,
      configSources: loaded.sources,
    },
    findings,
    suppressed: memOut.suppressed,
    refuted,
    fixed,
    impact,
    history,
    split,
    score,
    gate,
    usage,
    estimate,
    notes,
  };

  if (opts.saveState !== false && !opts.estimateOnly) {
    try {
      mkdirSync(join(changes.root, '.plumb', 'state'), { recursive: true });
      writeFileSync(sf, JSON.stringify({ at: result.meta.startedAt, head: result.meta.headSha, findings, suppressed: memOut.suppressed }, null, 1));
      writeFileSync(join(changes.root, '.plumb', 'state', 'last.json'), JSON.stringify(result, null, 1));
      appendFileSync(
        join(changes.root, '.plumb', 'state', 'history.jsonl'),
        JSON.stringify({
          at: result.meta.startedAt,
          branch,
          head: result.meta.headSha,
          provider: result.meta.provider,
          usd: result.usage.usd,
          raised: findings.map((f) => ({ id: f.id, severity: f.severity, category: f.category, source: f.source, status: f.status ?? 'new' })),
          fixed: fixed.map((f) => ({ id: f.id, severity: f.severity, category: f.category, source: f.source })),
          suppressed: memOut.suppressed.map((f) => ({ id: f.id, severity: f.severity, category: f.category, rule: f.memory?.ruleId })),
          refuted: refuted.length,
        }) + '\n',
      );
    } catch {
      notes.push('Could not save review state (read-only checkout?).');
    }
  }
  return result;
}

/** Keep only well-anchored candidates and replace model-written evidence with real source text. */
function normalize(ctx: AnalysisContext, unit: ReviewUnit, cands: Candidate[], staticFindings: Finding[], notes: string[]): Candidate[] {
  const out: Candidate[] = [];
  let dropped = 0;
  for (const c of cands) {
    const fc = unit.files.find((f) => f.path === c.file) ?? unit.files.find((f) => f.path.endsWith('/' + c.file) || c.file.endsWith('/' + f.path));
    if (!fc) {
      dropped++;
      continue;
    }
    c.file = fc.path;
    const visible = commentableLines(fc);
    if (!visible.has(c.line)) {
      const near = [...fc.added].sort((a, b) => Math.abs(a - c.line) - Math.abs(b - c.line))[0];
      if (near === undefined || Math.abs(near - c.line) > 3) {
        dropped++;
        continue;
      }
      c.line = near;
    }
    if (c.endLine !== undefined && (c.endLine < c.line || c.endLine - c.line > 30)) c.endLine = undefined;
    // Duplicate of something static analysis already proved.
    if (staticFindings.some((s) => s.file === c.file && Math.abs(s.line - c.line) <= 2 && (s.category === c.category || s.category === 'contract'))) continue;
    c.evidence = (c.evidence ?? []).filter((e) => {
      const t = lineText(ctx.changes.newSnap, e.file, e.line);
      return t.trim().length > 0;
    });
    out.push(c);
  }
  if (dropped) notes.push(`${dropped} model finding(s) dropped because they pointed outside the diff.`);
  return out;
}

function toFinding(ctx: AnalysisContext, c: Candidate, verification: Finding['verification'], confidence: number): Finding {
  const snap = ctx.changes.newSnap;
  return finalize(
    {
      source: 'llm',
      rule: `llm/${c.category}`,
      severity: c.severity,
      category: c.category,
      file: c.file,
      line: c.line,
      endLine: c.endLine,
      title: c.title.trim().slice(0, 160),
      body: c.body.trim(),
      evidence: (c.evidence ?? []).slice(0, 4).map((e) => evidence(snap, e.file, e.line, e.note)),
      suggestion: c.suggestion?.replace(/^```\w*\n?|```$/g, '').replace(/\n$/, '') || undefined,
      confidence,
      verification,
    },
    snap,
  );
}
