import pc from 'picocolors';
import type { ReviewResult } from '../review/pipeline.js';
import type { Finding } from '../types.js';
import { redactSecrets } from '../redact.js';

const SEV_COLOR = { P0: pc.red, P1: pc.yellow, P2: pc.cyan } as const;
const VERIF_LABEL: Record<Finding['verification'], string> = {
  reproduced: 'reproduced by a failing test',
  deterministic: 'proven by static analysis',
  confirmed: 'confirmed by skeptic pass',
  unverified: 'unverified',
  refuted: 'refuted',
};

function wrap(text: string, width: number, indent: string): string {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      if ((line + ' ' + word).trim().length > width) {
        out.push(indent + line.trim());
        line = word;
      } else line += ' ' + word;
    }
    out.push(indent + line.trim());
  }
  return out.join('\n');
}

export function renderTerminal(r: ReviewResult, opts: { width?: number; showRefuted?: boolean; source?: (file: string) => string | null } = {}): string {
  const width = Math.min(opts.width ?? process.stdout.columns ?? 100, 110) - 4;
  const out: string[] = [];
  const scoreColor = r.score.score >= 5 ? pc.green : r.score.score >= 4 ? pc.cyan : r.score.score >= 3 ? pc.yellow : pc.red;

  out.push('');
  out.push(`${pc.bold('plumb')} ${pc.dim(`v${r.meta.version}`)}  ${r.meta.label}  ${pc.dim(`${r.meta.filesReviewed} files, +${r.meta.linesAdded} -${r.meta.linesRemoved}`)}`);
  out.push(`${scoreColor(pc.bold(`${r.score.score}/5`))}  ${r.score.verdict}   ${pc.dim(`risk: ${r.history.riskLevel}`)}`);
  out.push('');

  const byFile = new Map<string, Finding[]>();
  for (const f of r.findings) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);

  if (!r.findings.length) out.push(pc.green('  No issues found.'));
  for (const [file, fs] of byFile) {
    out.push(pc.bold(pc.underline(file)));
    for (const f of fs) {
      const tag = SEV_COLOR[f.severity](pc.bold(f.severity));
      const status = f.status === 'new' ? pc.magenta(' new') : f.status === 'open' ? pc.dim(' still open') : '';
      out.push(`  ${tag} ${pc.dim(`L${f.line}`)} ${pc.bold(f.title)}${status}`);
      out.push(pc.dim(`     ${f.category} · ${VERIF_LABEL[f.verification]}${f.memory ? ` · memory ${f.memory.ruleId} ${f.memory.action}` : ''} · id ${f.id}`));
      const src = opts.source?.(f.file);
      if (src) {
        const lines = src.split('\n');
        const end = f.endLine ?? f.line;
        for (let n = Math.max(1, f.line - 1); n <= Math.min(lines.length, end + 1); n++) {
          const mark = n >= f.line && n <= end ? pc.red('▌') : ' ';
          out.push(`   ${mark}${pc.dim(String(n).padStart(5))}  ${redactSecrets(lines[n - 1]).slice(0, width - 10)}`);
        }
      }
      out.push(wrap(f.body, width - 5, '     '));
      if (f.evidence.length) {
        out.push(pc.dim('     evidence:'));
        for (const e of f.evidence) out.push(`       ${pc.cyan(`${e.file}:${e.line}`)} ${pc.dim(e.note)}${e.snippet ? `\n         ${pc.dim(e.snippet.slice(0, width - 10))}` : ''}`);
      }
      if (f.suggestion) {
        out.push(pc.dim('     suggested fix:'));
        for (const l of f.suggestion.split('\n').slice(0, 12)) out.push(`       ${pc.green('+ ' + l)}`);
      }
      if (f.verifierNote && f.verification === 'confirmed') out.push(pc.dim(wrap(`skeptic: ${f.verifierNote}`, width - 5, '     ')));
      if (f.repro) {
        const label = f.repro.outcome === 'reproduced' ? pc.green('reproduced: the generated test fails on this code') : f.repro.outcome === 'not-reproduced' ? pc.yellow('not reproduced: the generated test passed') : pc.dim('repro inconclusive: the test could not run');
        out.push(`     ${label} ${pc.dim(`(${f.repro.testPath})`)}`);
        if (f.repro.outcome === 'reproduced') for (const l of f.repro.output.split('\n').filter((x) => /fail|assert|expect|error/i.test(x)).slice(0, 4)) out.push(pc.dim(`       ${l.trim().slice(0, width - 10)}`));
      }
      out.push('');
    }
  }

  if (r.fixed.length) {
    out.push(pc.green(pc.bold(`Fixed since last review (${r.fixed.length})`)));
    for (const f of r.fixed) out.push(`  ${pc.green('✓')} ${f.file}:${f.line} ${pc.dim(f.title)}`);
    out.push('');
  }

  const reached = r.impact.entries.filter((e) => e.callers.length);
  if (reached.length) {
    out.push(pc.bold('Blast radius'));
    for (const e of reached.slice(0, 8)) {
      const outside = e.callers.filter((c) => !c.inDiff).length;
      out.push(`  ${e.symbol} ${pc.dim(`(${e.file}:${e.line}, ${e.change})`)}  ${e.callers.length} caller${e.callers.length === 1 ? '' : 's'}${outside ? pc.yellow(`, ${outside} outside the diff`) : ''}${e.testedBy.length ? '' : pc.dim(', no test calls it')}`);
      for (const c of e.callers.slice(0, 4)) out.push(pc.dim(`    └ ${c.file}:${c.line}${c.inDiff ? ' (changed)' : ''}`));
      if (e.callers.length > 4) out.push(pc.dim(`    └ +${e.callers.length - 4} more`));
    }
    out.push('');
  }

  const hot = r.history.files.filter((h) => h.reverts.length || h.fixes >= 3);
  if (hot.length) {
    out.push(pc.bold('History'));
    for (const h of hot.slice(0, 5)) {
      out.push(`  ${h.file}  ${pc.dim(`${h.commits} commit${h.commits === 1 ? '' : 's'}, ${h.fixes} fix${h.fixes === 1 ? '' : 'es'}`)}${h.reverts.length ? pc.yellow(`, reverted ${h.reverts.length}x: "${h.reverts[0].subject}"`) : ''}`);
    }
    out.push('');
  }

  if (r.history.reviewers.length) {
    out.push(`${pc.bold('Suggested reviewers')}  ${r.history.reviewers.map((x) => `${x.name} ${pc.dim(`(${x.files.length} file${x.files.length === 1 ? '' : 's'})`)}`).join(', ')}`);
    out.push('');
  }

  if (r.split) {
    out.push(pc.bold('This change is big. Suggested split:'));
    out.push(pc.dim(`  ${r.split.reason}`));
    r.split.parts.forEach((p, i) => {
      out.push(`  ${i + 1}. ${p.title} ${pc.dim(`(${p.files.length} files, ${p.lines} lines${p.dependsOn.length ? `, after ${p.dependsOn.join(', ')}` : ''})`)}`);
    });
    out.push('');
  }

  out.push(pc.bold('Score'));
  if (!r.score.breakdown.length) out.push(pc.dim('  5.00, nothing deducted'));
  for (const b of r.score.breakdown) out.push(`  ${pc.red(b.delta.toFixed(2).padStart(6))}  ${pc.dim(b.reason.slice(0, width - 10))}`);
  for (const reason of r.gate.reasons) out.push(pc.dim(`  ${reason}`));
  out.push('');

  const extras: string[] = [];
  if (r.suppressed.length) extras.push(`${r.suppressed.length} hidden by team memory (plumb memory list)`);
  if (r.refuted.length) extras.push(`${r.refuted.length} model finding${r.refuted.length === 1 ? '' : 's'} discarded by the skeptic pass${opts.showRefuted ? '' : ' (--show-refuted)'}`);
  if (extras.length) out.push(pc.dim(extras.join(' · ')));
  if (opts.showRefuted && r.refuted.length) {
    for (const f of r.refuted) out.push(pc.dim(`  ✗ ${f.file}:${f.line} ${f.title}\n    ${f.verifierNote ?? ''}`));
  }
  const cost = r.usage.calls
    ? `${r.meta.provider}/${r.meta.model}, ${r.usage.calls} calls, ${r.usage.inputTokens.toLocaleString()} in / ${r.usage.outputTokens.toLocaleString()} out${r.usage.cacheReadTokens ? `, ${r.usage.cacheReadTokens.toLocaleString()} cached` : ''}, $${r.usage.usd.toFixed(3)}`
    : 'static checks only, $0';
  out.push(pc.dim(`${cost} · ${(r.meta.durationMs / 1000).toFixed(1)}s`));
  for (const n of r.notes) out.push(pc.yellow(`! ${n}`));
  out.push('');
  return out.join('\n');
}
