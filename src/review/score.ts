// Explainable confidence score and merge gate. Every point lost is itemized, and
// the auto-approve decision always says why, whether it approves or not.

import picomatch from 'picomatch';
import type { PlumbConfig } from '../config.js';
import type { HistoryReport } from '../analyzers/history.js';
import type { FileChange, Finding } from '../types.js';

export interface ScoreReport {
  score: number;
  raw: number;
  breakdown: { delta: number; reason: string }[];
  verdict: string;
}

const WEIGHT = { P0: 2.5, P1: 1, P2: 0.25 } as const;

export function scoreReview(findings: Finding[], hist: HistoryReport): ScoreReport {
  const breakdown: ScoreReport['breakdown'] = [];
  let raw = 5;
  let p2Total = 0;
  for (const f of findings) {
    const trust = f.verification === 'unverified' || f.repro?.outcome === 'not-reproduced' ? 0.6 : 1;
    let d = WEIGHT[f.severity] * trust;
    if (f.severity === 'P2') {
      if (p2Total >= 1) continue;
      d = Math.min(d, 1 - p2Total);
      p2Total += d;
    }
    raw -= d;
    breakdown.push({ delta: -round(d), reason: `${f.severity} ${f.file}:${f.line} ${f.title}${trust < 1 ? (f.repro?.outcome === 'not-reproduced' ? ' (repro test passed, weighted 60%)' : ' (unverified, weighted 60%)') : f.verification === 'reproduced' ? ' (reproduced by a failing test)' : ''}` });
  }
  const serious = findings.some((f) => f.severity !== 'P2');
  if (serious && hist.riskLevel === 'critical') {
    raw -= 0.5;
    breakdown.push({ delta: -0.5, reason: `issues in a critical-risk change (${hist.riskReasons[0] ?? 'sensitive area'})` });
  }
  raw = Math.max(0, raw);
  const score = Math.max(0, Math.min(5, Math.floor(raw + 1e-9)));
  const verdict =
    score === 5 ? 'Ready to merge' : score === 4 ? 'Merge after small fixes' : score === 3 ? 'Address the findings first' : score === 2 ? 'Significant bugs, needs rework' : 'Critical problems, rethink before merging';
  return { score, raw: round(raw), breakdown, verdict };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface GateDecision {
  approve: boolean;
  reasons: string[];
}

const RISK_ORDER = ['low', 'medium', 'high', 'critical'] as const;

export function decideGate(
  cfg: PlumbConfig['autoApprove'],
  score: ScoreReport,
  hist: HistoryReport,
  files: FileChange[],
  extra: { draft?: boolean; changesRequested?: boolean; labels?: string[]; newCommitsSinceStart?: boolean } = {},
): GateDecision {
  const blockers: string[] = [];
  if (!cfg.enabled) return { approve: false, reasons: ['Auto-approve is off for this repo (autoApprove.enabled = false).'] };
  if (score.score < 5) blockers.push(`score is ${score.score}/5; auto-approve needs a clean 5/5`);
  if (RISK_ORDER.indexOf(hist.riskLevel) > RISK_ORDER.indexOf(cfg.maxRisk)) {
    blockers.push(`risk is ${hist.riskLevel}, above the ${cfg.maxRisk} ceiling${hist.riskReasons.length ? ` (${hist.riskReasons.slice(0, 2).join('; ')})` : ''}`);
  }
  const touched = files.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path]));
  if (cfg.excludePaths.length) {
    const ex = picomatch(cfg.excludePaths.map((p) => (/[*?[]/.test(p) ? p : `${p.replace(/\/$/, '')}/**`)), { dot: true });
    const hit = touched.filter((p) => ex(p));
    if (hit.length) blockers.push(`touches protected path${hit.length > 1 ? 's' : ''}: ${hit.slice(0, 3).join(', ')}`);
  }
  if (cfg.includePaths.length) {
    const inc = picomatch(cfg.includePaths, { dot: true });
    const out = touched.filter((p) => !inc(p));
    if (out.length) blockers.push(`changes files outside includePaths: ${out.slice(0, 3).join(', ')}`);
  }
  if (extra.draft) blockers.push('the PR is a draft');
  if (extra.changesRequested) blockers.push('a human reviewer requested changes');
  if (extra.newCommitsSinceStart) blockers.push('new commits landed while the review ran');
  const stopLabel = extra.labels?.find((l) => /^(do-not-merge|manual-review|wip)$/i.test(l));
  if (stopLabel) blockers.push(`labelled "${stopLabel}"`);

  if (blockers.length) return { approve: false, reasons: blockers.map((b) => `Not auto-approved: ${b}.`) };
  return {
    approve: true,
    reasons: [`Auto-approved: clean 5/5 review, risk ${hist.riskLevel} is within the ${cfg.maxRisk} ceiling, no protected paths touched.`],
  };
}
