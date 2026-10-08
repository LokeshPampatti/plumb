// Self-contained HTML report. Visual language: a surveyor's field sheet.
// Warm paper, ink, a plumb line down the margin, serif numerals, an itemized
// deduction ledger. No external scripts; fonts degrade to system faces offline.

import type { ReviewResult } from '../review/pipeline.js';
import type { Finding } from '../types.js';
import { fixPrompt } from './markdown.js';
import { redactSecrets } from '../redact.js';

const h = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const md = (s: string) => h(s).replace(/`([^`]+)`/g, '<code>$1</code>');

const VERIF: Record<Finding['verification'], string> = {
  deterministic: 'Proven by static analysis',
  confirmed: 'Confirmed by skeptic pass',
  unverified: 'Unverified',
  refuted: 'Refuted',
};

function frame(src: string | null, f: Finding): string {
  if (!src) return '';
  const lines = src.split('\n');
  const end = f.endLine ?? f.line;
  const from = Math.max(1, f.line - 3);
  const to = Math.min(lines.length, end + 3);
  const rows: string[] = [];
  for (let n = from; n <= to; n++) {
    const hit = n >= f.line && n <= end;
    rows.push(`<tr class="${hit ? 'hit' : ''}"><td class="ln">${n}</td><td class="src">${h(redactSecrets(lines[n - 1] ?? '')) || ' '}</td></tr>`);
  }
  return `<table class="frame">${rows.join('')}</table>`;
}

function findingCard(f: Finding, i: number, src: (file: string) => string | null): string {
  const ev = f.evidence
    .map(
      (e, k) =>
        `<li><span class="mark">${k + 1}</span><div><code class="loc">${h(e.file)}:${e.line}</code> <span class="note">${md(e.note)}</span>${e.snippet ? `<pre>${h(e.snippet)}</pre>` : ''}</div></li>`,
    )
    .join('');
  return `
  <article class="finding sev-${f.severity}" data-sev="${f.severity}" id="f-${f.id}">
    <header>
      <span class="sev">${f.severity}</span>
      <span class="num">№ ${String(i + 1).padStart(2, '0')}</span>
      <span class="where"><code>${h(f.file)}:${f.line}</code></span>
      ${f.status === 'new' ? '<span class="pill new">new</span>' : f.status === 'open' ? '<span class="pill">still open</span>' : ''}
    </header>
    <h3>${md(f.title)}</h3>
    ${frame(src(f.file), f)}
    <p class="body">${md(f.body)}</p>
    ${ev ? `<ol class="evidence">${ev}</ol>` : ''}
    ${f.suggestion ? `<div class="fix"><div class="label">Suggested fix</div><pre>${h(f.suggestion)}</pre></div>` : ''}
    <footer>
      <span class="verif v-${f.verification}">${VERIF[f.verification]}</span>
      <span>${h(f.category)}</span>
      ${f.memory ? `<span>memory ${h(f.memory.ruleId)} ${h(f.memory.action)}</span>` : ''}
      <span class="id">${f.id}</span>
    </footer>
    ${f.verifierNote && f.verification === 'confirmed' ? `<p class="skeptic"><b>Skeptic:</b> ${md(f.verifierNote)}</p>` : ''}
  </article>`;
}

function blastSvg(r: ReviewResult): string {
  const entries = r.impact.entries.filter((e) => e.callers.length).slice(0, 6);
  if (!entries.length) return '';
  const rowH = 30;
  const blocks: string[] = [];
  let y = 18;
  for (const e of entries) {
    const callers = e.callers.slice(0, 6);
    const h0 = y;
    blocks.push(`<text x="0" y="${y + 4}" class="sym">${h(e.symbol)}</text>`);
    callers.forEach((c, i) => {
      const cy = h0 + i * rowH;
      blocks.push(
        `<path d="M 210 ${h0} C 260 ${h0}, 260 ${cy}, 310 ${cy}" class="${c.inDiff ? 'edge' : 'edge out'}"/>`,
        `<circle cx="310" cy="${cy}" r="3.5" class="${c.inDiff ? 'dot' : 'dot out'}"/>`,
        `<text x="322" y="${cy + 4}" class="caller">${h(c.file)}:${c.line}${c.inDiff ? '' : '  · outside diff'}</text>`,
      );
    });
    if (e.callers.length > 6) blocks.push(`<text x="322" y="${h0 + 6 * rowH + 4}" class="caller dim">+${e.callers.length - 6} more</text>`);
    y = h0 + Math.max(1, Math.min(7, e.callers.length + (e.callers.length > 6 ? 1 : 0))) * rowH + 18;
  }
  return `<svg class="blast" viewBox="0 0 760 ${y}" preserveAspectRatio="xMinYMin meet" role="img" aria-label="Callers of changed code">${blocks.join('')}</svg>`;
}

export function renderHtml(r: ReviewResult, src: (file: string) => string | null): string {
  const counts = { P0: 0, P1: 0, P2: 0 };
  for (const f of r.findings) counts[f.severity]++;
  const ledger = r.score.breakdown.length
    ? r.score.breakdown.map((b) => `<tr><td class="d">${b.delta.toFixed(2)}</td><td>${md(b.reason)}</td></tr>`).join('')
    : '<tr><td class="d">0.00</td><td>Nothing deducted</td></tr>';
  const bobTop = 8 + (5 - r.score.score) * 16; // the plumb bob sits lower as the score drops

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Plumb review · ${h(r.meta.label)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root {
  --paper: #f3efe6; --paper-2: #ebe5d8; --ink: #1d1b16; --ink-2: #5d574b; --rule: #cfc6b3;
  --p0: #c2410c; --p1: #a16207; --p2: #3f6c8a; --ok: #3f7a4f; --line: #b91c1c;
  --code-bg: #fbf9f4; --hit: #f6e2cf;
  --serif: 'Instrument Serif', 'Iowan Old Style', Georgia, serif;
  --sans: 'Instrument Sans', -apple-system, 'Segoe UI', system-ui, sans-serif;
  --mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: #16150f; --paper-2: #1e1c16; --ink: #ece6d6; --ink-2: #a39b88; --rule: #3a362c;
    --p0: #f07a3f; --p1: #d9a93b; --p2: #7fb0d1; --ok: #7cbf8c; --line: #e5534b;
    --code-bg: #1b1a14; --hit: #3a2a1c;
  }
}
:root[data-theme="dark"] {
  --paper: #16150f; --paper-2: #1e1c16; --ink: #ece6d6; --ink-2: #a39b88; --rule: #3a362c;
  --p0: #f07a3f; --p1: #d9a93b; --p2: #7fb0d1; --ok: #7cbf8c; --line: #e5534b;
  --code-bg: #1b1a14; --hit: #3a2a1c;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--paper); color: var(--ink); }
body { font: 15px/1.6 var(--sans); -webkit-font-smoothing: antialiased; }
code, pre, .ln, .loc, .id, .num { font-family: var(--mono); font-size: 12.5px; font-variant-ligatures: none; }
.sheet { max-width: 980px; margin: 0 auto; padding: 48px 24px 96px 72px; position: relative; }
.sheet::before { content: ''; position: absolute; left: 40px; top: 0; bottom: 0; width: 1px; background: var(--line); opacity: .55; }
.bob { position: absolute; left: 33px; top: ${bobTop + 150}px; width: 15px; height: 22px; background: var(--line);
  clip-path: polygon(50% 100%, 0 30%, 15% 0, 85% 0, 100% 30%); transition: top .6s; }
.kicker { font: 500 11px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--ink-2); }
h1 { font: 400 clamp(34px, 6vw, 56px)/1.02 var(--serif); margin: 14px 0 8px; letter-spacing: -.01em; }
h1 em { font-style: italic; color: var(--ink-2); }
.meta { color: var(--ink-2); font-size: 13.5px; }
.meta code { font-size: 12px; }
.top { display: grid; grid-template-columns: auto 1fr; gap: 40px; align-items: start; margin: 40px 0 28px; padding: 28px 0; border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
.score { font: 400 112px/0.8 var(--serif); letter-spacing: -.03em; }
.score small { font-size: 40px; color: var(--ink-2); }
.verdict { font: italic 400 22px/1.2 var(--serif); margin-top: 12px; }
.ledger { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.ledger td { padding: 5px 0; border-bottom: 1px dotted var(--rule); vertical-align: top; }
.ledger td.d { font-family: var(--mono); font-size: 12.5px; color: var(--p0); width: 64px; }
.ledger caption { text-align: left; font: 500 11px var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--ink-2); padding-bottom: 8px; }
.gate { margin-top: 14px; font-size: 13.5px; color: var(--ink-2); }
.counts { display: flex; gap: 22px; flex-wrap: wrap; margin: 0 0 26px; }
.counts button { all: unset; cursor: pointer; font: 500 12px var(--mono); letter-spacing: .06em; padding: 6px 0; border-bottom: 2px solid transparent; color: var(--ink-2); }
.counts button[aria-pressed="true"] { color: var(--ink); border-color: var(--ink); }
.counts b { font-weight: 500; }
h2 { font: 400 30px/1.1 var(--serif); margin: 56px 0 18px; }
h2 .kicker { display: block; margin-bottom: 8px; }
.finding { padding: 26px 0 24px; border-top: 1px solid var(--rule); position: relative; }
.finding header { display: flex; gap: 14px; align-items: baseline; flex-wrap: wrap; }
.sev { font: 600 12px var(--mono); padding: 2px 7px; color: var(--paper); border-radius: 2px; }
.sev-P0 .sev { background: var(--p0); } .sev-P1 .sev { background: var(--p1); } .sev-P2 .sev { background: var(--p2); }
.finding::before { content: ''; position: absolute; left: -36px; top: 33px; width: 9px; height: 9px; border-radius: 50%; border: 2px solid var(--paper); }
.sev-P0::before { background: var(--p0); } .sev-P1::before { background: var(--p1); } .sev-P2::before { background: var(--p2); }
.num { color: var(--ink-2); }
.where code { color: var(--ink); }
.pill { font: 500 11px var(--mono); color: var(--ink-2); border: 1px solid var(--rule); padding: 1px 7px; border-radius: 99px; }
.pill.new { color: var(--p0); border-color: var(--p0); }
.finding h3 { font: 400 25px/1.2 var(--serif); margin: 10px 0 14px; }
.finding h3 code, .body code, .note code, .ledger code { font-size: .86em; background: var(--paper-2); padding: 1px 5px; border-radius: 3px; }
.finding h3 code { font-size: .74em; vertical-align: .08em; }
.frame { width: 100%; border-collapse: collapse; background: var(--code-bg); border: 1px solid var(--rule); margin: 0 0 14px; display: block; overflow-x: auto; }
.frame td { padding: 1px 12px; white-space: pre; font-family: var(--mono); font-size: 12.5px; }
.frame .ln { color: var(--ink-2); text-align: right; user-select: none; border-right: 1px solid var(--rule); width: 1%; }
.frame tr.hit td { background: var(--hit); }
.frame tr.hit .src { box-shadow: inset 0 -1px 0 var(--line); }
.body { margin: 0 0 14px; max-width: 70ch; }
.evidence { list-style: none; padding: 0; margin: 0 0 14px; }
.evidence li { display: grid; grid-template-columns: 22px 1fr; gap: 8px; padding: 6px 0; font-size: 13.5px; }
.evidence .mark { font: italic 400 18px/1 var(--serif); color: var(--line); }
.evidence pre { margin: 4px 0 0; padding: 6px 10px; background: var(--code-bg); border-left: 2px solid var(--rule); white-space: pre-wrap; word-break: break-word; }
.fix { margin: 0 0 14px; }
.fix .label, .label { font: 500 11px var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--ok); margin-bottom: 6px; }
.fix pre { margin: 0; padding: 10px 14px; background: var(--code-bg); border-left: 2px solid var(--ok); overflow-x: auto; }
.finding footer { display: flex; gap: 16px; flex-wrap: wrap; font: 400 12px var(--mono); color: var(--ink-2); }
.v-deterministic, .v-confirmed { color: var(--ok); }
.v-unverified { color: var(--p1); }
.skeptic { font-size: 13px; color: var(--ink-2); margin: 10px 0 0; max-width: 70ch; }
.blast-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.blast { width: 100%; min-width: 620px; height: auto; font-family: var(--mono); }
.blast .sym { font: 500 13px var(--mono); fill: var(--ink); }
.blast .caller { font-size: 12px; fill: var(--ink-2); }
.blast .edge { fill: none; stroke: var(--ink-2); stroke-width: 1; }
.blast .edge.out { stroke: var(--p0); stroke-dasharray: 3 3; }
.blast .dot { fill: var(--ink-2); } .blast .dot.out { fill: var(--p0); }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 28px; }
.small { font-size: 13.5px; }
.small ul { padding-left: 18px; margin: 6px 0; }
.empty { font: italic 400 26px var(--serif); color: var(--ok); padding: 30px 0; border-top: 1px solid var(--rule); }
.prompt { position: relative; }
.prompt pre { max-height: 260px; overflow: auto; padding: 34px 14px 14px; background: var(--code-bg); border: 1px solid var(--rule); white-space: pre-wrap; }
.prompt button { all: unset; cursor: pointer; position: absolute; top: 10px; right: 12px; font: 500 11px var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--ink-2); }
.colophon { margin-top: 64px; padding-top: 16px; border-top: 1px solid var(--rule); font: 400 12px var(--mono); color: var(--ink-2); display: flex; gap: 18px; flex-wrap: wrap; }
.theme { all: unset; cursor: pointer; position: absolute; right: 24px; top: 48px; font: 500 11px var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--ink-2); }
@media (max-width: 640px) {
  .sheet { padding: 28px 16px 72px 34px; }
  .sheet::before { left: 18px; } .bob { left: 11px; }
  .finding::before { left: -20px; }
  .top { grid-template-columns: 1fr; gap: 18px; }
  .score { font-size: 88px; }
  .theme { position: static; display: block; margin-bottom: 14px; }
  .finding h3 { font-size: 22px; }
}
@media (prefers-reduced-motion: no-preference) {
  .finding { animation: settle .5s both; }
  @keyframes settle { from { opacity: 0; transform: translateY(6px); filter: blur(2px); } }
}
</style>
</head>
<body>
<main class="sheet">
  <div class="bob" aria-hidden="true"></div>
  <button class="theme" onclick="var d=document.documentElement;d.dataset.theme=d.dataset.theme==='dark'?'light':'dark'">Theme</button>
  <div class="kicker">Plumb · field report · ${h(new Date(r.meta.startedAt).toISOString().slice(0, 16).replace('T', ' '))}</div>
  <h1>${h(r.meta.label)}<br><em>${r.findings.length ? `${r.findings.length} finding${r.findings.length === 1 ? '' : 's'}` : 'nothing to fix'}</em></h1>
  <div class="meta">${r.meta.filesReviewed} files · +${r.meta.linesAdded} −${r.meta.linesRemoved} · risk <b>${h(r.history.riskLevel)}</b> · head <code>${h(r.meta.headSha.slice(0, 9))}</code></div>

  <section class="top">
    <div>
      <div class="score">${r.score.score}<small>/5</small></div>
      <div class="verdict">${h(r.score.verdict)}</div>
    </div>
    <div>
      <table class="ledger"><caption>How the score was computed · starts at 5.00</caption>${ledger}</table>
      <div class="gate">${r.gate.reasons.map((x) => md(x)).join('<br>')}</div>
    </div>
  </section>

  ${
    r.findings.length
      ? `<div class="counts" role="group" aria-label="Filter by severity">
    <button aria-pressed="true" data-f="all">All <b>${r.findings.length}</b></button>
    <button aria-pressed="false" data-f="P0">P0 <b>${counts.P0}</b></button>
    <button aria-pressed="false" data-f="P1">P1 <b>${counts.P1}</b></button>
    <button aria-pressed="false" data-f="P2">P2 <b>${counts.P2}</b></button>
  </div>
  ${r.findings.map((f, i) => findingCard(f, i, src)).join('')}`
      : '<p class="empty">Plumb and level. No issues found.</p>'
  }

  ${
    r.fixed.length
      ? `<h2><span class="kicker">Since last review</span>Fixed</h2><ul class="small">${r.fixed.map((f) => `<li><s>${md(f.title)}</s> <code>${h(f.file)}</code></li>`).join('')}</ul>`
      : ''
  }

  ${
    r.impact.entries.some((e) => e.callers.length)
      ? `<h2><span class="kicker">Code graph</span>Blast radius</h2>
  <p class="small">Who calls the code this change touched. Dashed red lines are callers outside the diff: places a diff-only review never reads.</p>
  <div class="blast-wrap">${blastSvg(r)}</div>`
      : ''
  }

  <h2><span class="kicker">Context</span>Around this change</h2>
  <div class="cols small">
    <div><div class="label">History</div>
      <ul>${
        r.history.files
          .slice(0, 6)
          .map((f) => `<li><code>${h(f.file)}</code>: ${f.commits} commit${f.commits === 1 ? '' : 's'}, ${f.fixes} fix${f.fixes === 1 ? '' : 'es'}${f.reverts.length ? `, <b>reverted ${f.reverts.length}×</b>` : ''}${f.sensitive ? ', sensitive' : ''}</li>`)
          .join('') || '<li>No history yet</li>'
      }</ul>
    </div>
    <div><div class="label">Suggested reviewers</div>
      <ul>${r.history.reviewers.map((x) => `<li>${h(x.name)} <span class="meta">(${x.files.length} file${x.files.length === 1 ? '' : 's'})</span></li>`).join('') || '<li>None found in history</li>'}</ul>
    </div>
    ${
      r.split
        ? `<div><div class="label">Suggested split</div><p>${h(r.split.reason)}</p><ol>${r.split.parts.map((p) => `<li>${h(p.title)} <span class="meta">(${p.files.length} files)</span></li>`).join('')}</ol></div>`
        : ''
    }
  </div>

  ${
    r.findings.length
      ? `<h2><span class="kicker">Hand off</span>Fix with your coding agent</h2>
  <div class="prompt"><button onclick="navigator.clipboard.writeText(this.nextElementSibling.innerText);this.textContent='Copied'">Copy</button><pre>${h(fixPrompt(r.findings))}</pre></div>`
      : ''
  }

  <div class="colophon">
    <span>${r.usage.calls ? `${h(r.meta.provider)} / ${h(r.meta.model)} · ${r.usage.calls} calls · $${r.usage.usd.toFixed(3)}` : 'static checks only · $0.00'}</span>
    ${r.refuted.length ? `<span>${r.refuted.length} model finding${r.refuted.length === 1 ? '' : 's'} discarded by the skeptic</span>` : ''}
    ${r.suppressed.length ? `<span>${r.suppressed.length} hidden by team memory</span>` : ''}
    <span>${(r.meta.durationMs / 1000).toFixed(1)}s</span>
    <span>plumb v${h(r.meta.version)}</span>
  </div>
</main>
<script>
document.querySelectorAll('.counts button').forEach(function (b) {
  b.addEventListener('click', function () {
    document.querySelectorAll('.counts button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
    var f = b.dataset.f;
    document.querySelectorAll('.finding').forEach(function (el) { el.style.display = f === 'all' || el.dataset.sev === f ? '' : 'none'; });
  });
});
</script>
</body>
</html>`;
}
