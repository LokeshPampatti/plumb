import { createHash } from 'node:crypto';
import type { ReviewResult } from '../review/pipeline.js';
import type { Finding } from '../types.js';

const SEV = { P0: '🔴 **P0**', P1: '🟠 **P1**', P2: '🔵 **P2**' } as const;
const VERIF: Record<Finding['verification'], string> = {
  reproduced: 'reproduced by a failing test',
  deterministic: 'proven by static analysis',
  confirmed: 'confirmed by an independent skeptic pass',
  unverified: 'not independently verified',
  refuted: 'refuted',
};

export const SUMMARY_MARKER = '<!-- plumb:summary -->';

function esc(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Body for one inline PR comment. */
export function inlineComment(f: Finding, repoUrl?: string): string {
  const lines: string[] = [];
  lines.push(`${SEV[f.severity]} · ${f.category} · _${VERIF[f.verification]}_`);
  lines.push('');
  lines.push(`**${f.title}**`);
  lines.push('');
  lines.push(f.body);
  if (f.evidence.length) {
    lines.push('');
    lines.push('<details><summary>Evidence</summary>\n');
    for (const e of f.evidence) {
      const loc = repoUrl ? `[\`${e.file}:${e.line}\`](${repoUrl}/${e.file}#L${e.line})` : `\`${e.file}:${e.line}\``;
      lines.push(`- ${loc} ${e.note}${e.snippet ? `\n  \`\`\`\n  ${e.snippet}\n  \`\`\`` : ''}`);
    }
    lines.push('\n</details>');
  }
  if (f.repro && f.repro.outcome !== 'inconclusive') {
    lines.push('');
    lines.push(`<details><summary>${f.repro.outcome === 'reproduced' ? '🧪 Reproduced: this test fails on the PR' : '🧪 Not reproduced: this test passed'}</summary>\n`);
    lines.push('```');
    lines.push(f.repro.test.trim());
    lines.push('```');
    lines.push('```text');
    lines.push(f.repro.output.trim().split('\n').slice(-12).join('\n'));
    lines.push('```');
    lines.push('\n</details>');
  }
  if (f.suggestion) {
    lines.push('');
    lines.push('```suggestion');
    lines.push(f.suggestion);
    lines.push('```');
  }
  lines.push('');
  lines.push(`<sub>React 👎 or reply \`/plumb dismiss <reason>\` to teach Plumb; the lesson is saved to \`.plumb/memory.json\`. id \`${f.id}\`</sub>`);
  lines.push(`<!-- plumb:finding=${f.id} -->`);
  return lines.join('\n');
}

/** Copy-paste prompt for any coding agent (Claude Code, Codex, Cursor...). */
export function fixPrompt(findings: Finding[]): string {
  const parts = findings.map(
    (f, i) =>
      `${i + 1}. ${f.file}:${f.line}${f.endLine ? `-${f.endLine}` : ''} [${f.severity}] ${f.title}\n   ${f.body}\n` +
      (f.evidence.length ? `   Evidence: ${f.evidence.map((e) => `${e.file}:${e.line} (${e.note})`).join('; ')}\n` : '') +
      (f.suggestion ? `   Suggested replacement:\n${f.suggestion.split('\n').map((l) => '      ' + l).join('\n')}\n` : ''),
  );
  return `Fix these code review findings. Verify each one against the code first; if a finding is wrong, say why instead of changing code. Run the tests afterwards.\n\n${parts.join('\n')}`;
}

/** The top-level PR summary comment. */
export function renderMarkdown(r: ReviewResult, opts: { inlineIds?: Set<string>; repoUrl?: string } = {}): string {
  const out: string[] = [SUMMARY_MARKER];
  const emoji = r.score.score >= 5 ? '✅' : r.score.score >= 4 ? '🟢' : r.score.score >= 3 ? '🟡' : '🔴';
  out.push(`## ${emoji} Plumb review: ${r.score.score}/5, ${r.score.verdict.toLowerCase()}`);
  out.push('');
  out.push(
    `${r.meta.filesReviewed} files · +${r.meta.linesAdded} −${r.meta.linesRemoved} · risk **${r.history.riskLevel}**` +
      (r.history.riskReasons.length ? ` (${r.history.riskReasons.slice(0, 2).join('; ')})` : ''),
  );
  out.push('');

  if (r.findings.length) {
    out.push('| | Finding | Where | How we know |');
    out.push('|---|---|---|---|');
    for (const f of r.findings) {
      const where = opts.repoUrl ? `[\`${f.file}:${f.line}\`](${opts.repoUrl}/${f.file}#L${f.line})` : `\`${f.file}:${f.line}\``;
      out.push(`| ${SEV[f.severity]}${f.status === 'new' ? ' 🆕' : ''} | ${esc(f.title)} | ${where} | ${VERIF[f.verification]} |`);
    }
    out.push('');
  } else {
    out.push('No issues found.');
    out.push('');
  }

  const outside = r.findings.filter((f) => opts.inlineIds && !opts.inlineIds.has(f.id));
  if (outside.length) {
    out.push('### Problems outside this diff');
    out.push('These lines are not part of the change, so GitHub cannot show them inline.');
    out.push('');
    for (const f of outside) {
      out.push(`<details><summary>${SEV[f.severity]} ${esc(f.title)} (<code>${f.file}:${f.line}</code>)</summary>\n`);
      out.push(f.body);
      for (const e of f.evidence) out.push(`- \`${e.file}:${e.line}\` ${e.note}${e.snippet ? `: \`${e.snippet.replace(/`/g, "'")}\`` : ''}`);
      out.push('\n</details>');
    }
    out.push('');
  }

  if (r.fixed.length) {
    out.push(`### ✅ Fixed since the last review (${r.fixed.length})`);
    for (const f of r.fixed) out.push(`- ~~${esc(f.title)}~~ \`${f.file}\``);
    out.push('');
  }

  const reached = r.impact.entries.filter((e) => e.callers.length);
  if (reached.length) {
    out.push('<details><summary><b>Blast radius</b>: ' + `${r.impact.reach.length} file${r.impact.reach.length === 1 ? '' : 's'} outside this diff call changed code</summary>\n`);
    out.push(blastMermaid(r));
    out.push('| Changed symbol | Callers | Outside diff | Tested by |');
    out.push('|---|---|---|---|');
    for (const e of reached.slice(0, 15)) {
      out.push(`| \`${e.symbol}\`${e.change === 'signature' ? ' (signature changed)' : ''} | ${e.callers.length} | ${e.callers.filter((c) => !c.inDiff).length} | ${e.testedBy.length ? e.testedBy.map((t) => `\`${t}\``).join(', ') : '⚠️ none'} |`);
    }
    out.push('\n</details>\n');
  }

  if (r.split) {
    out.push(`<details><summary><b>Suggested split</b>: ${r.split.reason}</summary>\n`);
    r.split.parts.forEach((p, i) => out.push(`${i + 1}. **${p.title}** (${p.files.length} files, ${p.lines} lines)${p.dependsOn.length ? `, after ${p.dependsOn.join(', ')}` : ''}\n   ${p.files.slice(0, 8).map((f) => `\`${f}\``).join(', ')}${p.files.length > 8 ? ', …' : ''}`));
    out.push('\n</details>\n');
  }

  if (r.history.reviewers.length) {
    out.push(`**Suggested reviewers** (most recent experience with these files): ${r.history.reviewers.map((x) => x.name).join(', ')}`);
    out.push('');
  }

  out.push('<details><summary><b>How this score was computed</b></summary>\n');
  out.push('Starts at 5.00.');
  for (const b of r.score.breakdown) out.push(`- ${b.delta.toFixed(2)} ${esc(b.reason)}`);
  out.push('');
  for (const g of r.gate.reasons) out.push(`> ${g}`);
  out.push('\n</details>\n');

  if (r.findings.length) {
    out.push('<details><summary><b>Fix all with your coding agent</b> (copy this prompt into Claude Code, Codex or Cursor)</summary>\n');
    out.push('```text');
    out.push(fixPrompt(r.findings));
    out.push('```');
    out.push('\n</details>\n');
  }

  const meta: string[] = [];
  if (r.refuted.length) meta.push(`${r.refuted.length} model finding${r.refuted.length === 1 ? '' : 's'} thrown out by the skeptic pass`);
  if (r.suppressed.length) meta.push(`${r.suppressed.length} hidden by team memory`);
  meta.push(r.usage.calls ? `${r.meta.model}, $${r.usage.usd.toFixed(3)}` : 'static checks only');
  meta.push(`${(r.meta.durationMs / 1000).toFixed(0)}s`);
  out.push(`<sub>${meta.join(' · ')} · reviewed \`${r.meta.headSha.slice(0, 7)}\`</sub>`);
  return out.join('\n');
}

/** Mermaid graph of changed symbols and their callers. Built from the code graph, no model involved. */
export function blastMermaid(r: ReviewResult): string {
  const entries = r.impact.entries.filter((e) => e.callers.length).slice(0, 8);
  if (!entries.length) return '';
  const id = (s: string) => 'n' + createHash('sha1').update(s).digest('hex').slice(0, 10);
  const label = (s: string) => s.replace(/["<>]/g, '');
  const lines = ['```mermaid', 'graph LR'];
  const files = new Set<string>();
  for (const e of entries) {
    lines.push(`  ${id(e.file + e.symbol)}["${label(e.symbol)}${e.change === 'signature' ? ' (signature changed)' : ''}"]:::changed`);
    for (const c of e.callers.slice(0, 6)) {
      const fid = id(c.file);
      if (!files.has(c.file)) {
        files.add(c.file);
        lines.push(`  ${fid}["${label(c.file)}"]${c.inDiff ? '' : ':::outside'}`);
      }
      lines.push(`  ${fid} ${c.inDiff ? '-->' : '-.->'} ${id(e.file + e.symbol)}`);
    }
  }
  lines.push('  classDef changed fill:#fde7d9,stroke:#c2410c', '  classDef outside stroke-dasharray: 4 3', '```', '');
  return lines.join('\n');
}
