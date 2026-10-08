// Apply suggested fixes from the last review to the working tree. A fix is only
// applied when the flagged lines still read exactly as they did at review time.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprint } from './analyzers/context.js';
import type { Finding, Severity } from './types.js';

export interface FixPlan {
  applied: { finding: Finding; before: string[]; after: string[] }[];
  skipped: { finding: Finding; reason: string }[];
}

const RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 };

export function planFixes(root: string, findings: Finding[], opts: { ids?: string[]; maxSeverity?: Severity } = {}): FixPlan {
  const plan: FixPlan = { applied: [], skipped: [] };
  const wanted = findings.filter((f) => f.suggestion !== undefined && (!opts.ids || opts.ids.some((id) => f.id.startsWith(id))) && RANK[f.severity] <= RANK[opts.maxSeverity ?? 'P2']);
  const byFile = new Map<string, Finding[]>();
  for (const f of wanted) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);

  for (const [file, fs] of byFile) {
    const abs = join(root, file);
    if (!existsSync(abs)) {
      for (const f of fs) plan.skipped.push({ finding: f, reason: 'file no longer exists' });
      continue;
    }
    const lines = readFileSync(abs, 'utf8').split('\n');
    // Bottom-up so earlier replacements don't shift later line numbers.
    const sorted = [...fs].sort((a, b) => b.line - a.line);
    let floor = Infinity;
    for (const f of sorted) {
      const end = f.endLine ?? f.line;
      if (end >= floor) {
        plan.skipped.push({ finding: f, reason: 'overlaps another fix in the same file' });
        continue;
      }
      if (f.line < 1 || end > lines.length || fingerprint(f.rule, f.file, lines[f.line - 1] ?? '', f.title) !== f.id) {
        plan.skipped.push({ finding: f, reason: 'the code changed since the review' });
        continue;
      }
      const before = lines.slice(f.line - 1, end);
      const after = f.suggestion!.replace(/\r\n/g, '\n').split('\n');
      lines.splice(f.line - 1, end - f.line + 1, ...after);
      plan.applied.push({ finding: f, before, after });
      floor = f.line;
    }
    (plan as FixPlan & { files?: Map<string, string> }).files ??= new Map();
    (plan as FixPlan & { files: Map<string, string> }).files.set(file, lines.join('\n'));
  }
  return plan;
}

export function writeFixes(root: string, plan: FixPlan): void {
  const files = (plan as FixPlan & { files?: Map<string, string> }).files;
  if (!files) return;
  const touched = new Set(plan.applied.map((a) => a.finding.file));
  for (const [file, text] of files) if (touched.has(file)) writeFileSync(join(root, file), text);
}
