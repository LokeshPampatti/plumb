// Merge several bench/results/*.json runs into one scoreboard. Later runs win when a
// case appears twice. Deep re-runs of the misses are scored separately, never mixed in.
// Usage: npx tsx bench/aggregate.ts results/a.json results/b.json ... [--deep results/c.json,results/d.json]

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface CaseResult {
  id: string;
  bug: string;
  caught: boolean;
  how: string | null;
  findings: number;
  seconds: number;
  others: string[];
}

const here = dirname(fileURLToPath(import.meta.url));
const dataset = (JSON.parse(readFileSync(join(here, 'dataset.json'), 'utf8')) as { cases: { id: string; caughtBy: string[]; severity: string }[] }).cases;
const caseOf = (id: string) => dataset.find((c) => c.id === id)!;

const argv = process.argv.slice(2);
const deepAt = argv.indexOf('--deep');
const deepFiles = deepAt >= 0 ? (argv[deepAt + 1] ?? '').split(',').filter(Boolean) : [];
const files = argv.filter((a, i) => a !== '--deep' && i !== deepAt + 1 || deepAt < 0);
if (!files.length) {
  console.error('usage: tsx bench/aggregate.ts <results.json>... [--deep a.json,b.json]');
  process.exit(1);
}

function load(paths: string[]): Map<string, CaseResult> {
  const byId = new Map<string, CaseResult>();
  for (const f of paths) for (const r of (JSON.parse(readFileSync(f, 'utf8')) as { results: CaseResult[] }).results) byId.set(r.id, r);
  return byId;
}
const base = load(files);
const deep = load(deepFiles);

const order = dataset.map((c) => c.id).filter((id) => base.has(id));
const rows = order.map((id) => base.get(id)!);
const n = rows.length;
const pct = (k: number) => `${Math.round((100 * k) / Math.max(1, n))}%`;
const tools = ['greptile', 'cursor', 'copilot', 'coderabbit', 'graphite'];
const others = Object.fromEntries(tools.map((t) => [t, order.filter((id) => caseOf(id).caughtBy.includes(t)).length]));
const caught = rows.filter((r) => r.caught);
const deepSaves = rows.filter((r) => !r.caught && deep.get(r.id)?.caught).map((r) => r.id);
const deepTried = rows.filter((r) => !r.caught && deep.has(r.id)).length;
const combined = caught.length + deepSaves.length;
const plumbOnlyVsGreptile = rows.filter((r) => (r.caught || deepSaves.includes(r.id)) && !caseOf(r.id).caughtBy.includes('greptile')).map((r) => r.id);
const missedVsGreptile = rows.filter((r) => !r.caught && !deepSaves.includes(r.id) && caseOf(r.id).caughtBy.includes('greptile')).map((r) => r.id);
const avgFindings = rows.reduce((s, r) => s + r.findings, 0) / Math.max(1, n);
const ranking = [...tools.map((t) => ({ name: t, score: others[t] as number })), { name: '**plumb**', score: caught.length }].sort((a, b) => b.score - a.score);

const lines = [
  `# Plumb on Greptile's benchmark: ${n} of ${dataset.length} PRs`,
  '',
  `Default depth: Plumb caught **${caught.length}/${n}** (${pct(caught.length)}), ${caught.filter((r) => r.how === 'static').length} of them with $0 static analysis. Avg ${avgFindings.toFixed(1)} findings per PR.`,
  deepFiles.length
    ? `With \`--depth deep\` re-run on the ${deepTried} misses (scored separately): ${deepSaves.length} more caught, **${combined}/${n}** (${pct(combined)}) in total${deepSaves.length ? ` (${deepSaves.join(', ')})` : ''}.`
    : '',
  '',
  `Greptile's own published table, same ${n} PRs: ${ranking.map((r) => `${r.name} ${r.score}`).join(', ')}.`,
  '',
  plumbOnlyVsGreptile.length ? `Plumb caught, Greptile missed: ${plumbOnlyVsGreptile.join(', ')}.` : '',
  missedVsGreptile.length ? `Greptile caught, Plumb missed: ${missedVsGreptile.join(', ')}.` : '',
  '',
  `| Case | Bug | Plumb | How | ${deepFiles.length ? 'Deep | ' : ''}Greptile | Others |`,
  `|---|---|---|---|${deepFiles.length ? '---|' : ''}---|---|`,
  ...rows.map((r) => {
    const c = caseOf(r.id);
    const rest = c.caughtBy.filter((t) => t !== 'greptile');
    const d = deep.get(r.id);
    const deepCell = deepFiles.length ? `${r.caught ? '' : d ? (d.caught ? '✅' : '—') : ''} | ` : '';
    return `| ${r.id} | ${r.bug.replace(/\|/g, '\\|')} | ${r.caught ? '✅' : '—'} | ${r.how ?? ''} | ${deepCell}${c.caughtBy.includes('greptile') ? '✅' : '—'} | ${rest.join(', ')} |`;
  }),
  '',
];
const md = lines.filter((l, i) => l !== '' || lines[i - 1] !== '').join('\n');
const out = join(here, 'results', 'SUMMARY.md');
writeFileSync(out, md);
console.log(md);
console.log(`\nwrote ${out}`);
