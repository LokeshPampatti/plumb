// Builds the context a model sees for one slice of the diff: the numbered diff,
// the full enclosing functions, the callers and callees the graph found, what
// static analysis already proved, and the history of the file.

import { renderNumberedDiff } from '../diff.js';
import { rulesFor } from '../config.js';
import type { AnalysisContext } from '../analyzers/context.js';
import type { Impact } from '../analyzers/impact.js';
import type { HistoryReport } from '../analyzers/history.js';
import type { FileChange, Finding } from '../types.js';
import { approxTokens } from '../llm/provider.js';
import { redactBlock } from '../redact.js';

export interface ReviewUnit {
  files: FileChange[];
  text: string;
  tokens: number;
}

function numbered(src: string, from: number, to: number): string {
  const lines = src.split('\n');
  const out: string[] = [];
  for (let i = Math.max(1, from); i <= Math.min(lines.length, to); i++) out.push(`${String(i).padStart(5)} | ${lines[i - 1]}`);
  return out.join('\n');
}

function fileSection(ctx: AnalysisContext, fc: FileChange, impact: Impact, hist: HistoryReport, staticFindings: Finding[], maxCallers: number): string {
  const { newIndex, changes } = ctx;
  const parts: string[] = [];
  parts.push(`### FILE ${fc.path}${fc.oldPath ? ` (renamed from ${fc.oldPath})` : ''} [${fc.status}]`);

  const h = hist.files.find((x) => x.file === fc.path);
  if (h && (h.reverts.length || h.fixes >= 3 || h.sensitive)) {
    const notes: string[] = [];
    if (h.sensitive) notes.push('sensitive path');
    if (h.fixes) notes.push(`${h.fixes} fix commits in the last year`);
    for (const r of h.reverts.slice(0, 3)) notes.push(`reverted before: "${r.subject}"`);
    parts.push(`History: ${notes.join('; ')}`);
  }

  const rules = rulesFor(ctx.loaded, fc.path);
  if (rules.length) parts.push('Team rules that apply to this file:\n' + rules.map((r) => `- ${r}`).join('\n'));

  parts.push('Diff (new-file line numbers on the left; + added, - removed):\n```\n' + renderNumberedDiff(fc, 600) + '\n```');

  // Full text of every changed function so the model sees the whole body, not just the hunk.
  const src = changes.newSnap.read(fc.path);
  if (src && fc.status !== 'deleted') {
    const shown = new Set<string>();
    const bodies: string[] = [];
    let budget = 9000;
    for (const n of [...fc.added].sort((a, b) => a - b)) {
      const d = newIndex.enclosingDef(fc.path, n);
      if (!d || shown.has(`${d.name}:${d.line}`)) continue;
      shown.add(`${d.name}:${d.line}`);
      const span = d.endLine - d.line;
      if (span > 220) continue;
      const text = numbered(src, d.line, d.endLine);
      budget -= text.length;
      if (budget < 0) break;
      bodies.push(`Full current text of \`${d.name}\` (${fc.path}:${d.line}-${d.endLine}):\n\`\`\`\n${text}\n\`\`\``);
    }
    parts.push(...bodies);
  }

  // Callers of changed symbols, with surrounding lines.
  const entries = impact.entries.filter((e) => e.file === fc.path && e.callers.length);
  if (entries.length) {
    const lines: string[] = ['Callers of changed symbols (found by the code graph):'];
    for (const e of entries.slice(0, 6)) {
      lines.push(`- \`${e.symbol}\`${e.oldSignature ? ` signature changed from \`${e.oldSignature}\` to \`${e.signature}\`` : ''}`);
      for (const c of e.callers.slice(0, maxCallers)) {
        const csrc = changes.newSnap.read(c.file);
        if (!csrc) continue;
        lines.push(`  ${c.file}:${c.line}${c.inDiff ? ' (in this diff)' : ''}\n` + '```\n' + numbered(csrc, c.line - 2, c.line + 2) + '\n```');
      }
      if (e.callers.length > maxCallers) lines.push(`  ...and ${e.callers.length - maxCallers} more callers`);
    }
    parts.push(lines.join('\n'));
  }

  // Signatures of what the changed code calls into elsewhere in the repo.
  const calleeSigs = new Map<string, string>();
  const facts = newIndex.facts.get(fc.path);
  if (facts) {
    for (const call of facts.calls) {
      if (!fc.added.has(call.line)) continue;
      for (const r of newIndex.resolveCall(fc.path, call)) {
        if (r.file === fc.path && r.confidence < 0.9) continue;
        const key = `${r.file}:${r.def.name}`;
        if (!calleeSigs.has(key) && calleeSigs.size < 15) calleeSigs.set(key, `${r.file}:${r.def.line}  ${r.def.signature}`);
      }
    }
  }
  if (calleeSigs.size) parts.push('Definitions the changed lines call:\n' + [...calleeSigs.values()].map((s) => `- ${s}`).join('\n'));

  const facts2 = staticFindings.filter((f) => f.file === fc.path || f.evidence.some((e) => e.file === fc.path));
  if (facts2.length) {
    parts.push(
      'Already proven by static analysis (do NOT repeat these; build on them):\n' + facts2.map((f) => `- [${f.severity}] ${f.file}:${f.line} ${f.title}`).join('\n'),
    );
  }
  return redactBlock(parts.join('\n\n'));
}

/** Pack changed files into units that fit a token budget. Related files go together. */
export function buildUnits(ctx: AnalysisContext, impact: Impact, hist: HistoryReport, staticFindings: Finding[], maxTokens = 24000): ReviewUnit[] {
  const files = ctx.changes.files.filter((f) => ctx.reviewFiles.has(f.path) && !f.binary && f.status !== 'deleted');
  // Biggest risk first so a budget cut drops the least important files.
  const risk = new Map(hist.files.map((h) => [h.file, h.risk]));
  files.sort((a, b) => (risk.get(b.path) ?? 0) - (risk.get(a.path) ?? 0) || b.added.size - a.added.size);

  const units: ReviewUnit[] = [];
  let cur: { files: FileChange[]; parts: string[]; tokens: number } = { files: [], parts: [], tokens: 0 };
  for (const fc of files) {
    // Secrets never leave the machine: redact before anything is sent to a model.
    const text = redactBlock(fileSection(ctx, fc, impact, hist, staticFindings, ctx.loaded.config.context.maxCallers));
    const t = approxTokens(text);
    if (cur.files.length && cur.tokens + t > maxTokens) {
      units.push({ files: cur.files, text: cur.parts.join('\n\n'), tokens: cur.tokens });
      cur = { files: [], parts: [], tokens: 0 };
    }
    cur.files.push(fc);
    cur.parts.push(text);
    cur.tokens += t;
  }
  if (cur.files.length) units.push({ files: cur.files, text: cur.parts.join('\n\n'), tokens: cur.tokens });
  return units;
}

/** Shared, cacheable context for every call in one review: conventions and instruction files. */
export function sharedContext(ctx: AnalysisContext, prDescription?: string): string {
  const parts: string[] = [];
  if (prDescription?.trim()) parts.push('## Author\'s description of the change\n' + prDescription.trim().slice(0, 4000));
  if (ctx.loaded.instructionFiles.length) {
    let budget = 12000;
    const docs: string[] = [];
    for (const f of ctx.loaded.instructionFiles) {
      const t = f.text.slice(0, Math.max(0, budget));
      budget -= t.length;
      if (t) docs.push(`### ${f.path}\n${t}`);
    }
    parts.push('## Project instruction files (the team\'s own conventions)\n' + docs.join('\n\n'));
  }
  const global = ctx.loaded.scopedRules.filter((r) => r.dir === '');
  if (global.length) parts.push('## Team rules\n' + global.map((r) => `- ${r.text}`).join('\n'));
  return redactBlock(parts.join('\n\n'));
}
