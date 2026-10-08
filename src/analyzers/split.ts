// "Split this PR": cluster a large change into independently reviewable parts,
// ordered so each part only depends on the ones before it.

import { posix } from 'node:path';
import { isTestPath } from '../index/languages.js';
import type { AnalysisContext } from './context.js';

export interface SplitPart {
  title: string;
  files: string[];
  lines: number;
  dependsOn: number[];
}

export interface SplitPlan {
  reason: string;
  parts: SplitPart[];
}

export function suggestSplit(ctx: AnalysisContext): SplitPlan | null {
  const { changes, newIndex, loaded } = ctx;
  const files = changes.files.filter((f) => f.status !== 'deleted' || true).map((f) => f.path);
  const lines = new Map(changes.files.map((f) => [f.path, f.added.size + f.removed.size]));
  const total = [...lines.values()].reduce((a, b) => a + b, 0);
  const { maxFiles, maxLines } = loaded.config.split;
  if (files.length <= maxFiles && total <= maxLines) return null;

  // Edges: A -> B when A imports or calls into B. Union-find over the undirected version.
  const set = new Set(files);
  const deps = new Map<string, Set<string>>(files.map((f) => [f, new Set<string>()]));
  for (const f of files) {
    for (const imp of newIndex.importsOf(f)) {
      for (const t of newIndex.resolveModule(f, imp.module)) if (set.has(t) && t !== f) deps.get(f)!.add(t);
    }
  }
  // Tests travel with the code they test (same basename stem).
  const stem = (p: string) => posix.basename(p).replace(/(\.|_|-)(test|spec)(?=\.)/, '').replace(/^test_/, '').replace(/\.[^.]+$/, '');
  for (const f of files) {
    if (!isTestPath(f)) continue;
    const subject = files.find((g) => g !== f && !isTestPath(g) && stem(g) === stem(f));
    if (subject) deps.get(f)!.add(subject);
  }

  const parent = new Map(files.map((f) => [f, f]));
  const find = (x: string): string => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
  for (const [a, bs] of deps) for (const b of bs) parent.set(find(a), find(b));

  const groups = new Map<string, string[]>();
  for (const f of files) {
    const r = find(f);
    groups.set(r, [...(groups.get(r) ?? []), f]);
  }
  // Merge singleton leftovers by top-level directory so we don't emit 40 one-file PRs.
  const merged = new Map<string, string[]>();
  for (const g of groups.values()) {
    const key = g.length === 1 ? `dir:${g[0].split('/').slice(0, 2).join('/')}` : `grp:${g[0]}`;
    merged.set(key, [...(merged.get(key) ?? []), ...g]);
  }
  let parts = [...merged.values()].map((fs) => ({ files: fs.sort(), lines: fs.reduce((n, f) => n + (lines.get(f) ?? 0), 0) }));
  if (parts.length < 2) {
    // One connected blob: fall back to directory layers.
    const byDir = new Map<string, string[]>();
    for (const f of files) {
      const d = f.split('/').slice(0, 2).join('/');
      byDir.set(d, [...(byDir.get(d) ?? []), f]);
    }
    if (byDir.size < 2) return null;
    parts = [...byDir.values()].map((fs) => ({ files: fs.sort(), lines: fs.reduce((n, f) => n + (lines.get(f) ?? 0), 0) }));
  }

  // Order: parts that others depend on go first.
  const partOf = new Map<string, number>();
  parts.forEach((p, i) => p.files.forEach((f) => partOf.set(f, i)));
  const partDeps = parts.map((p, i) => {
    const s = new Set<number>();
    for (const f of p.files) for (const t of deps.get(f) ?? []) {
      const j = partOf.get(t);
      if (j !== undefined && j !== i) s.add(j);
    }
    return s;
  });
  const order: number[] = [];
  const state = new Map<number, 0 | 1 | 2>();
  const visit = (i: number) => {
    if (state.get(i) === 2 || state.get(i) === 1) return;
    state.set(i, 1);
    for (const j of partDeps[i]) visit(j);
    state.set(i, 2);
    order.push(i);
  };
  parts.forEach((_, i) => visit(i));
  const remap = new Map(order.map((old, idx) => [old, idx]));

  const out: SplitPart[] = order.map((i) => {
    const p = parts[i];
    const dirs = [...new Set(p.files.map((f) => posix.dirname(f)))];
    const allTests = p.files.every(isTestPath);
    const title = allTests ? `Tests: ${dirs[0]}` : dirs.length === 1 ? dirs[0] : `${dirs[0]} (+${dirs.length - 1} more dirs)`;
    return { title, files: p.files, lines: p.lines, dependsOn: [...partDeps[i]].map((j) => remap.get(j)! + 1).sort() };
  });
  return {
    reason: `${files.length} files and ${total} changed lines (over the ${maxFiles}-file / ${maxLines}-line threshold)`,
    parts: out,
  };
}
