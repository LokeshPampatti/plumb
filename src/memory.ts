// Team memory. Greptile learns from reactions over 2-3 weeks inside a black box.
// Plumb writes every lesson to .plumb/memory.json: readable, diffable, reviewable
// in a PR, effective on the very next run, and revertible with one command.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import picomatch from 'picomatch';
import type { Category, Finding } from './types.js';

export interface MemoryEvidence {
  date: string;
  who?: string;
  finding?: string;
  file?: string;
  title?: string;
  reason?: string;
}

export interface MemoryRule {
  id: string;
  kind: 'suppress' | 'downgrade' | 'prefer';
  text: string;
  match: { rule?: string; category?: Category; paths?: string[]; keywords?: string[] };
  evidence: MemoryEvidence[];
  createdAt: string;
  source: 'dismiss' | 'manual' | 'github-reaction' | 'github-reply';
  hits?: number;
}

export interface MemoryFile {
  version: 1;
  rules: MemoryRule[];
}

const STOP = new Set(
  'the a an and or but for with without this that these those from into onto when then than here there have has had does did will would could should might must can may not no yes its it is are was were be been being of on in to by as at if else any all some each every more most less least very also just only still even about after before over under between through during while where which what who whom whose why how use uses used using call calls called value values variable function method line lines code file files'.split(
    ' ',
  ),
);

export function keywords(text: string, max = 4): string[] {
  const words = text
    .toLowerCase()
    .replace(/`[^`]*`/g, ' ')
    .replace(/[^a-z0-9_ ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)].slice(0, max);
}

export function memoryPath(root: string): string {
  return join(root, '.plumb', 'memory.json');
}

export function loadMemory(root: string, text?: string | null): MemoryFile {
  const raw = text ?? (existsSync(memoryPath(root)) ? readFileSync(memoryPath(root), 'utf8') : null);
  if (!raw) return { version: 1, rules: [] };
  try {
    const m = JSON.parse(raw) as MemoryFile;
    return { version: 1, rules: Array.isArray(m.rules) ? m.rules : [] };
  } catch {
    return { version: 1, rules: [] };
  }
}

export function saveMemory(root: string, mem: MemoryFile): void {
  mkdirSync(dirname(memoryPath(root)), { recursive: true });
  writeFileSync(memoryPath(root), JSON.stringify(mem, null, 2) + '\n');
}

/** Findings that memory may never hide, no matter what the team clicked. */
export function isProtected(f: Finding): boolean {
  return f.severity === 'P0' || f.category === 'security' || f.category === 'secret' || f.rule.startsWith('contract/');
}

export function ruleMatches(rule: MemoryRule, f: Finding): boolean {
  const m = rule.match;
  if (m.rule && !f.rule.startsWith(m.rule)) return false;
  if (m.category && m.category !== f.category) return false;
  if (m.paths?.length && !picomatch(m.paths, { dot: true })(f.file)) return false;
  if (m.keywords?.length) {
    const hay = `${f.title} ${f.body}`.toLowerCase();
    const hits = m.keywords.filter((k) => hay.includes(k)).length;
    if (hits < Math.ceil(m.keywords.length / 2)) return false;
  }
  return true;
}

export interface MemoryOutcome {
  kept: Finding[];
  suppressed: Finding[];
  preferences: string[];
}

export function applyMemory(mem: MemoryFile, findings: Finding[]): MemoryOutcome {
  const kept: Finding[] = [];
  const suppressed: Finding[] = [];
  for (const f of findings) {
    if (isProtected(f)) {
      kept.push(f);
      continue;
    }
    const rule = mem.rules.find((r) => r.kind !== 'prefer' && ruleMatches(r, f));
    if (!rule) {
      kept.push(f);
      continue;
    }
    rule.hits = (rule.hits ?? 0) + 1;
    if (rule.kind === 'suppress') suppressed.push({ ...f, memory: { ruleId: rule.id, action: 'suppressed' } });
    else kept.push({ ...f, severity: 'P2', memory: { ruleId: rule.id, action: 'downgraded' } });
  }
  return { kept, suppressed, preferences: mem.rules.filter((r) => r.kind === 'prefer').map((r) => r.text) };
}

function ruleId(seed: string): string {
  return 'm_' + createHash('sha1').update(seed).digest('hex').slice(0, 6);
}

/** Turn a dismissed finding into a scoped, explainable rule (or strengthen an existing one). */
export function learnFromDismissal(
  mem: MemoryFile,
  f: Finding,
  opts: { reason?: string; who?: string; scope?: 'dir' | 'repo' | 'file'; kind?: 'suppress' | 'downgrade' } = {},
): { rule: MemoryRule; created: boolean; refused?: string } {
  if (isProtected(f)) {
    return {
      rule: null as unknown as MemoryRule,
      created: false,
      refused: 'P0, security, secret and contract findings cannot be silenced by memory. Fix the code or add an ignore pattern for the path.',
    };
  }
  const dir = posix.dirname(f.file);
  const paths = opts.scope === 'repo' ? undefined : opts.scope === 'file' ? [f.file] : [dir === '.' ? '**' : `${dir}/**`];
  const kw = keywords(f.title);
  const ev: MemoryEvidence = { date: new Date().toISOString().slice(0, 10), who: opts.who, finding: f.id, file: f.file, title: f.title, reason: opts.reason };

  const existing = mem.rules.find(
    (r) =>
      r.kind === (opts.kind ?? 'suppress') &&
      r.match.category === f.category &&
      JSON.stringify(r.match.paths ?? null) === JSON.stringify(paths ?? null) &&
      (r.match.keywords ?? []).filter((k) => kw.includes(k)).length >= Math.min(2, kw.length),
  );
  if (existing) {
    if (!existing.evidence.some((e) => e.finding === f.id)) existing.evidence.push(ev);
    return { rule: existing, created: false };
  }
  const where = paths ? paths[0].replace('/**', '/') : 'anywhere in the repo';
  const rule: MemoryRule = {
    id: ruleId(`${f.category}${paths}${kw.join()}${Date.now()}`),
    kind: opts.kind ?? 'suppress',
    text: opts.reason?.trim() || `Don't flag ${f.category} issues like "${f.title}" in ${where}`,
    match: { category: f.category, paths, keywords: kw.length ? kw : undefined },
    evidence: [ev],
    createdAt: ev.date,
    source: 'dismiss',
  };
  mem.rules.push(rule);
  return { rule, created: true };
}

export function addPreference(mem: MemoryFile, text: string, who?: string): MemoryRule {
  const rule: MemoryRule = {
    id: ruleId(text + Date.now()),
    kind: 'prefer',
    text: text.trim(),
    match: {},
    evidence: [{ date: new Date().toISOString().slice(0, 10), who }],
    createdAt: new Date().toISOString().slice(0, 10),
    source: 'manual',
  };
  mem.rules.push(rule);
  return rule;
}

export function forget(mem: MemoryFile, id: string): MemoryRule | null {
  const i = mem.rules.findIndex((r) => r.id === id);
  if (i < 0) return null;
  return mem.rules.splice(i, 1)[0];
}
