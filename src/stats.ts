import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Entry {
  at: string;
  branch: string;
  usd: number;
  raised: { id: string; severity: string; category: string; source: string; status: string }[];
  fixed: { id: string; severity: string; category: string; source: string }[];
  suppressed: { id: string; severity: string; category: string; rule?: string }[];
  refuted: number;
}

export interface Stats {
  runs: number;
  usd: number;
  distinct: number;
  fixed: number;
  dismissed: number;
  open: number;
  refuted: number;
  /** fixed / (fixed + dismissed): how often a finding was worth acting on. */
  addressedRate: number | null;
  byCategory: { category: string; raised: number; fixed: number; dismissed: number }[];
  bySource: { source: string; raised: number; fixed: number }[];
}

/** Review analytics, computed locally from .plumb/state/history.jsonl. */
export function computeStats(root: string, sinceDays = 90): Stats | null {
  const p = join(root, '.plumb', 'state', 'history.jsonl');
  if (!existsSync(p)) return null;
  const cutoff = Date.now() - sinceDays * 86400_000;
  const entries = readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Entry;
      } catch {
        return null;
      }
    })
    .filter((e): e is Entry => !!e && Date.parse(e.at) >= cutoff);
  const raised = new Map<string, { category: string; source: string }>();
  const fixed = new Set<string>();
  const dismissed = new Set<string>();
  let usd = 0;
  let refuted = 0;
  for (const e of entries) {
    usd += e.usd ?? 0;
    refuted += e.refuted ?? 0;
    for (const f of e.raised) raised.set(f.id, { category: f.category, source: f.source });
    for (const f of e.fixed) fixed.add(f.id);
    for (const f of e.suppressed) dismissed.add(f.id);
  }
  // The latest run decides what is still open.
  const last = new Map<string, string[]>();
  for (const e of entries) last.set(e.branch, e.raised.map((f) => f.id));
  const open = new Set([...last.values()].flat());
  const cats = new Map<string, { raised: number; fixed: number; dismissed: number }>();
  const srcs = new Map<string, { raised: number; fixed: number }>();
  for (const [id, f] of raised) {
    const c = cats.get(f.category) ?? { raised: 0, fixed: 0, dismissed: 0 };
    c.raised++;
    if (fixed.has(id)) c.fixed++;
    if (dismissed.has(id)) c.dismissed++;
    cats.set(f.category, c);
    const s = srcs.get(f.source) ?? { raised: 0, fixed: 0 };
    s.raised++;
    if (fixed.has(id)) s.fixed++;
    srcs.set(f.source, s);
  }
  const acted = fixed.size + dismissed.size;
  return {
    runs: entries.length,
    usd,
    distinct: raised.size,
    fixed: fixed.size,
    dismissed: dismissed.size,
    open: [...open].filter((id) => !fixed.has(id)).length,
    refuted,
    addressedRate: acted ? fixed.size / acted : null,
    byCategory: [...cats.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.raised - a.raised),
    bySource: [...srcs.entries()].map(([source, v]) => ({ source, ...v })),
  };
}
