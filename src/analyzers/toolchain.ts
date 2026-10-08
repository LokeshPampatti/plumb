// Runs the project's own type checkers and correctness linters and keeps only
// diagnostics on lines this change added. Nothing here executes project code:
// tsc, go vet and ruff only parse and type-check.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { langFor } from '../index/languages.js';
import type { Finding } from '../types.js';
import { evidence, finalize, type AnalysisContext } from './context.js';

export interface ToolResult {
  tool: string;
  ran: boolean;
  ms: number;
  note?: string;
  diagnostics: Diagnostic[];
}

export interface Diagnostic {
  file: string;
  line: number;
  code: string;
  message: string;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : -1) : 0, out: `${stdout}\n${stderr}`, timedOut: !!e?.killed });
    });
    child.on('error', () => resolve({ code: -1, out: '', timedOut: false }));
  });
}

function which(cmd: string): Promise<boolean> {
  return run('sh', ['-c', `command -v ${cmd}`], process.cwd(), 5000).then((r) => r.code === 0 && r.out.trim().length > 0);
}

/** tsc --pretty false: `src/a.ts(12,5): error TS2554: Expected 2 arguments, but got 1.` */
export function parseTsc(out: string, root: string, cwdRel = ''): Diagnostic[] {
  const diags: Diagnostic[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(.+?)\((\d+),\d+\): error (TS\d+): (.+)$/);
    if (!m) continue;
    const file = posix.normalize(posix.join(cwdRel, m[1].replace(/\\/g, '/'))).replace(/^\.\//, '');
    diags.push({ file: file.startsWith(root) ? relative(root, file) : file, line: Number(m[2]), code: m[3], message: m[4].trim() });
  }
  return diags;
}

/** go vet: `pkg/a/b.go:12:5: undefined: Foo` (also prefixed with `# pkg` headers and `vet:` lines). */
export function parseGoVet(out: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  for (const line of out.split('\n')) {
    const m = line.replace(/^vet: /, '').match(/^\.?\/?([^\s:]+\.go):(\d+):(?:\d+:)?\s+(.+)$/);
    if (m) diags.push({ file: m[1], line: Number(m[2]), code: 'govet', message: m[3].trim() });
  }
  return diags;
}

/** ruff --output-format json */
export function parseRuff(out: string, root: string): Diagnostic[] {
  const start = out.indexOf('[');
  if (start < 0) return [];
  try {
    const arr = JSON.parse(out.slice(start, out.lastIndexOf(']') + 1)) as { filename: string; location: { row: number }; code: string; message: string }[];
    return arr.map((d) => ({ file: relative(root, d.filename), line: d.location.row, code: d.code ?? 'ruff', message: d.message }));
  } catch {
    return [];
  }
}

// Only rules that indicate broken code, never style.
const RUFF_SELECT = 'F821,F822,F823,F632,F701,F702,F704,F706,F707,E9,PLE';

export async function runToolchain(ctx: AnalysisContext, opts: { timeoutMs?: number; log?: (m: string) => void } = {}): Promise<{ findings: Finding[]; results: ToolResult[] }> {
  const { changes } = ctx;
  const root = changes.root;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const results: ToolResult[] = [];
  // Tools read the working tree, so they only describe the "new" side when that is what's on disk.
  if (changes.headRef !== null) {
    return { findings: [], results: [{ tool: 'toolchain', ran: false, ms: 0, note: 'skipped: the reviewed revision is not checked out', diagnostics: [] }] };
  }
  const changed = changes.files.filter((f) => f.status !== 'deleted' && ctx.reviewFiles.has(f.path));
  const langs = new Set(changed.map((f) => langFor(f.path)?.id));

  if ((langs.has('typescript') || langs.has('tsx')) && existsSync(join(root, 'tsconfig.json'))) {
    const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
    if (existsSync(tsc)) {
      const t0 = Date.now();
      opts.log?.('Type-checking with tsc...');
      const r = await run(process.execPath, [tsc, '--noEmit', '--pretty', 'false', '-p', 'tsconfig.json'], root, timeoutMs);
      results.push({ tool: 'tsc', ran: !r.timedOut, ms: Date.now() - t0, note: r.timedOut ? 'timed out' : undefined, diagnostics: r.timedOut ? [] : parseTsc(r.out, root) });
    } else results.push({ tool: 'tsc', ran: false, ms: 0, note: 'typescript is not installed in node_modules', diagnostics: [] });
  }

  if (langs.has('go') && existsSync(join(root, 'go.mod')) && (await which('go'))) {
    const pkgs = [...new Set(changed.filter((f) => f.path.endsWith('.go')).map((f) => './' + posix.dirname(f.path)))].slice(0, 40);
    const t0 = Date.now();
    opts.log?.(`Running go vet on ${pkgs.length} package(s)...`);
    const r = await run('go', ['vet', ...pkgs], root, timeoutMs);
    results.push({ tool: 'go vet', ran: !r.timedOut, ms: Date.now() - t0, note: r.timedOut ? 'timed out' : undefined, diagnostics: r.timedOut ? [] : parseGoVet(r.out) });
  }

  if (langs.has('python') && (await which('ruff'))) {
    const files = changed.filter((f) => f.path.endsWith('.py')).map((f) => f.path).slice(0, 400);
    const t0 = Date.now();
    opts.log?.('Checking Python with ruff (correctness rules only)...');
    const r = await run('ruff', ['check', '--no-cache', '--output-format', 'json', '--select', RUFF_SELECT, ...files], root, timeoutMs);
    results.push({ tool: 'ruff', ran: !r.timedOut, ms: Date.now() - t0, note: r.timedOut ? 'timed out' : undefined, diagnostics: r.timedOut ? [] : parseRuff(r.out, root) });
  }

  // Keep only diagnostics on lines this change added: pre-existing problems are not this PR's fault.
  const added = new Map(changed.map((f) => [f.path, f.added]));
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const res of results) {
    for (const d of res.diagnostics) {
      if (!added.get(d.file)?.has(d.line)) continue;
      const key = `${d.file}:${d.line}:${d.code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(
        finalize(
          {
            source: 'static',
            rule: `toolchain/${res.tool.replace(/\s+/g, '-')}`,
            severity: 'P1',
            category: 'syntax',
            file: d.file,
            line: d.line,
            title: `${res.tool}: ${d.message.length > 110 ? d.message.slice(0, 107) + '...' : d.message}`,
            body: `\`${res.tool}\` reports ${d.code} on a line this change added: ${d.message}. This is your project's own toolchain, so it is not a model guess.`,
            evidence: [evidence(changes.newSnap, d.file, d.line, `${res.tool} ${d.code}`)],
            confidence: 0.98,
            verification: 'deterministic',
          },
          changes.newSnap,
        ),
      );
    }
  }
  return { findings, results };
}
