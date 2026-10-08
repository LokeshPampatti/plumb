// Blast radius and test coverage for every symbol the change touches.

import { isTestPath } from '../index/languages.js';
import type { AnalysisContext } from './context.js';

export interface ImpactCaller {
  file: string;
  line: number;
  inDiff: boolean;
  confidence: number;
}

export interface ImpactEntry {
  file: string;
  symbol: string;
  kind: 'function' | 'method' | 'class';
  line: number;
  signature: string;
  oldSignature?: string;
  change: 'added' | 'modified' | 'signature';
  callers: ImpactCaller[];
  testedBy: string[];
}

export interface Impact {
  entries: ImpactEntry[];
  /** Distinct files outside the diff that call into changed code. */
  reach: string[];
}

export function computeImpact(ctx: AnalysisContext): Impact {
  const { changes, newIndex, oldIndex } = ctx;
  const changedPaths = new Set(changes.files.map((f) => f.path));
  const addedLinesByFile = new Map(changes.files.map((f) => [f.path, f.added]));
  const entries: ImpactEntry[] = [];
  const reach = new Set<string>();

  for (const fc of changes.files) {
    if (fc.status === 'deleted' || !ctx.reviewFiles.has(fc.path)) continue;
    const oldPath = fc.oldPath ?? fc.path;
    for (const d of newIndex.defsIn(fc.path)) {
      let touched = false;
      for (const n of fc.added) if (n >= d.line && n <= d.endLine) touched = true;
      if (!touched) {
        // A deletion inside the body also counts.
        const od = oldIndex.defsIn(oldPath, d.name).find((o) => (o.container ?? '') === (d.container ?? ''));
        if (od) for (const n of fc.removed) if (n >= od.line && n <= od.endLine) touched = true;
      }
      if (!touched) continue;
      const od = fc.status === 'added' ? undefined : oldIndex.defsIn(oldPath, d.name).find((o) => (o.container ?? '') === (d.container ?? ''));
      const sigChanged = !!od && od.signature !== d.signature;
      const callers = d.kind === 'class' ? [] : newIndex.callersOf(fc.path, d.name, 0.6);
      const mapped: ImpactCaller[] = callers
        .filter((c) => !(c.file === fc.path && c.call.inDef === d.name))
        .map((c) => ({
          file: c.file,
          line: c.call.line,
          inDiff: changedPaths.has(c.file) && (addedLinesByFile.get(c.file)?.has(c.call.line) ?? false),
          confidence: c.confidence,
        }));
      for (const c of mapped) if (!changedPaths.has(c.file)) reach.add(c.file);
      const testedBy = [...new Set(mapped.filter((c) => isTestPath(c.file)).map((c) => c.file))];
      entries.push({
        file: fc.path,
        symbol: d.container ? `${d.container}.${d.name}` : d.name,
        kind: d.kind,
        line: d.line,
        signature: d.signature,
        oldSignature: sigChanged ? od!.signature : undefined,
        change: !od ? 'added' : sigChanged ? 'signature' : 'modified',
        callers: mapped,
        testedBy,
      });
    }
  }
  entries.sort((a, b) => b.callers.length - a.callers.length);
  return { entries, reach: [...reach].sort() };
}
