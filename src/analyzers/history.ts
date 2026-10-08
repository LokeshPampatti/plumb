// What git history says about the files in this change: churn, past fixes and
// reverts (incident memory), and who actually knows this code.

import picomatch from 'picomatch';
import { history, userEmail } from '../git.js';
import type { AnalysisContext } from './context.js';

export interface FileHistory {
  file: string;
  commits: number;
  fixes: number;
  reverts: { sha: string; subject: string; time: number }[];
  lastTouched?: number;
  sensitive: boolean;
  /** 0..1, combines churn, fix density, reverts and sensitivity. */
  risk: number;
}

export interface Reviewer {
  name: string;
  email: string;
  score: number;
  files: string[];
}

export interface HistoryReport {
  files: FileHistory[];
  reviewers: Reviewer[];
  /** Overall risk class used by the merge gate. */
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  riskReasons: string[];
}

const FIX_RE = /\b(fix(e[sd])?|bug|hotfix|patch|regression|broken|crash|incident|rollback)\b/i;
const REVERT_RE = /^Revert\b|\brevert(ed|s)?\b/i;

export function analyzeHistory(ctx: AnalysisContext): HistoryReport {
  const { changes, loaded } = ctx;
  const paths = changes.files.filter((f) => f.status !== 'added').map((f) => f.oldPath ?? f.path);
  const commits = history(changes.root, paths, { maxCount: 600, sinceDays: 365 });
  const isSensitive = picomatch(loaded.config.sensitivePaths, { dot: true, nocase: true });
  const me = userEmail(changes.root).toLowerCase();

  const byFile = new Map<string, FileHistory>();
  const authorship = new Map<string, { name: string; email: string; score: number; files: Set<string> }>();
  const now = Date.now() / 1000;

  for (const fc of changes.files) {
    byFile.set(fc.oldPath ?? fc.path, {
      file: fc.path,
      commits: 0,
      fixes: 0,
      reverts: [],
      sensitive: isSensitive(fc.path),
      risk: 0,
    });
  }

  for (const c of commits) {
    const isFix = FIX_RE.test(c.subject);
    const isRevert = REVERT_RE.test(c.subject);
    const ageDays = (now - c.time) / 86400;
    const recency = Math.exp(-ageDays / 120);
    for (const f of c.files) {
      const h = byFile.get(f);
      if (!h) continue;
      h.commits++;
      if (isFix) h.fixes++;
      if (isRevert && h.reverts.length < 5) h.reverts.push({ sha: c.sha.slice(0, 9), subject: c.subject, time: c.time });
      if (!h.lastTouched || c.time > h.lastTouched) h.lastTouched = c.time;
      const key = c.email.toLowerCase();
      if (key && key !== me && !/\[bot\]|noreply@github|dependabot|renovate/i.test(key + c.author)) {
        const a = authorship.get(key) ?? { name: c.author, email: c.email, score: 0, files: new Set<string>() };
        a.score += 0.3 + recency;
        a.files.add(h.file);
        authorship.set(key, a);
      }
    }
  }

  const reasons: string[] = [];
  let maxRisk = 0;
  for (const h of byFile.values()) {
    const churn = Math.min(1, h.commits / 40);
    const fixDensity = h.commits ? h.fixes / h.commits : 0;
    h.risk = Math.min(1, 0.35 * churn + 0.35 * fixDensity + (h.reverts.length ? 0.25 : 0) + (h.sensitive ? 0.3 : 0));
    maxRisk = Math.max(maxRisk, h.risk);
    if (h.reverts.length) reasons.push(`\`${h.file}\` has been reverted ${h.reverts.length}x in the last year (last: "${h.reverts[0].subject}")`);
    if (h.sensitive) reasons.push(`\`${h.file}\` matches a sensitive path`);
    if (h.commits >= 8 && fixDensity >= 0.4) reasons.push(`\`${h.file}\`: ${h.fixes} of its last ${h.commits} commits were fixes`);
  }

  const files = [...byFile.values()].sort((a, b) => b.risk - a.risk);
  const reviewers = [...authorship.values()]
    .map((a) => ({ name: a.name, email: a.email, score: Math.round(a.score * 10) / 10, files: [...a.files] }))
    .sort((a, b) => b.score - a.score)
    .slice(0, loaded.config.reviewers.max);

  const anySensitive = files.some((f) => f.sensitive);
  const totalLines = changes.files.reduce((n, f) => n + f.added.size + f.removed.size, 0);
  const touchesDeps = changes.files.some((f) => /(^|\/)(package\.json|requirements[^/]*\.txt|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|Gemfile|pyproject\.toml)$/.test(f.path));
  const onlyDocsOrTests = changes.files.every((f) => /\.(md|mdx|txt|rst)$/i.test(f.path) || /(^|\/)(docs?|test|tests|__tests__|spec)\//.test(f.path) || /[._-](test|spec)\./.test(f.path));
  let riskLevel: HistoryReport['riskLevel'] = 'medium';
  if (anySensitive) riskLevel = 'critical';
  else if (touchesDeps || maxRisk >= 0.6 || totalLines > 600) riskLevel = 'high';
  else if (onlyDocsOrTests || (totalLines <= 40 && maxRisk < 0.3)) riskLevel = 'low';
  if (touchesDeps) reasons.push('changes dependency manifests');
  if (totalLines > 600) reasons.push(`large change (${totalLines} lines)`);
  if (onlyDocsOrTests) reasons.push('docs/tests only');

  return { files, reviewers, riskLevel, riskReasons: reasons };
}
