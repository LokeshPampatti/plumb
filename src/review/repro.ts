// Opt-in proof by execution: for serious model findings, have the model write a
// minimal failing test in the project's own framework, run it, and record whether
// the bug actually reproduces. This runs model-written code on the machine, so it
// only happens with --repro (or repro: true in CI config).

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import type { AnalysisContext } from '../analyzers/context.js';
import { isTestPath, langFor } from '../index/languages.js';
import type { Provider } from '../llm/provider.js';
import { redactBlock } from '../redact.js';
import type { Finding } from '../types.js';

export interface Framework {
  id: 'vitest' | 'jest' | 'node-test' | 'pytest' | 'go-test';
  /** File name pattern for a new test next to the code under test. */
  testName: (base: string) => string;
  command: (testFile: string) => { cmd: string; args: string[] };
}

export interface ReproResult {
  findingId: string;
  outcome: 'reproduced' | 'not-reproduced' | 'inconclusive';
  testPath: string;
  testCode: string;
  output: string;
  ms: number;
}

function pkgJson(root: string): any {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function detectFramework(root: string, file: string): Framework | null {
  const lang = langFor(file)?.id;
  if (lang === 'typescript' || lang === 'tsx' || lang === 'javascript') {
    const pkg = pkgJson(root);
    const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
    const ext = file.match(/\.(m?[jt]sx?)$/)?.[1] ?? 'ts';
    if (deps.vitest && existsSync(join(root, 'node_modules', 'vitest')))
      return { id: 'vitest', testName: (b) => `${b}.plumb-repro.test.${ext}`, command: (t) => ({ cmd: process.execPath, args: [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', t] }) };
    if (deps.jest && existsSync(join(root, 'node_modules', 'jest')))
      return { id: 'jest', testName: (b) => `${b}.plumb-repro.test.${ext}`, command: (t) => ({ cmd: process.execPath, args: [join(root, 'node_modules', 'jest', 'bin', 'jest.js'), '--runTestsByPath', t] }) };
    if (ext.startsWith('m') || ext === 'js') return { id: 'node-test', testName: (b) => `${b}.plumb-repro.test.mjs`, command: (t) => ({ cmd: process.execPath, args: ['--test', t] }) };
    return null;
  }
  if (lang === 'python') return { id: 'pytest', testName: (b) => `test_plumb_repro_${b}.py`, command: (t) => ({ cmd: 'python3', args: ['-m', 'pytest', '-x', '-q', '-p', 'no:cacheprovider', t] }) };
  if (lang === 'go') return { id: 'go-test', testName: (b) => `${b}_plumb_repro_test.go`, command: (t) => ({ cmd: 'go', args: ['test', './' + posix.dirname(t), '-run', 'PlumbRepro', '-count=1'] }) };
  return null;
}

/** Classify a test run. An assertion failure is proof; a setup error is not. */
export function classify(fw: Framework['id'], code: number | null, out: string): ReproResult['outcome'] {
  if (code === 0) return 'not-reproduced';
  const setup =
    /Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError|Transform failed|Failed to load|ImportError|ModuleNotFoundError|ERROR collecting|errors during collection|\[build failed\]|cannot find package|undefined: |TS\d{4}:|command not found|ENOENT|No test files? found|no tests ran/i;
  if (setup.test(out)) return 'inconclusive';
  const assertion =
    fw === 'go-test' ? /--- FAIL/ : fw === 'pytest' ? /AssertionError|^E\s+assert|\bFAILED\b/m : /AssertionError|expected .* to |Expected:|toBe|toEqual|✗|×|FAIL\b/;
  return assertion.test(out) ? 'reproduced' : 'inconclusive';
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' } }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: `${stdout}\n${stderr}`.slice(-6000) });
    });
  });
}

const REPRO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'expectation'],
  properties: {
    code: { type: 'string', description: 'Complete test file contents' },
    expectation: { type: 'string', description: 'One sentence: which assertion fails if the bug is real' },
  },
};

const REPRO_SYSTEM = `You write minimal regression tests that prove or disprove a reported bug.

Write ONE small test file in the given framework. Import the real code under test with a relative import from the test file's location. The test must FAIL (an assertion failure, not an exception during setup) if and only if the reported bug is real, and PASS once it is fixed. No network, no filesystem writes outside a temp dir, no sleeping, no mocking the function under test. Keep it under 60 lines. If the bug cannot be shown in a unit test (needs a database, browser, or service), write a test that exercises as much as possible without those, and say so in the expectation.`;

export async function reproduce(
  ctx: AnalysisContext,
  provider: Provider,
  findings: Finding[],
  opts: { max?: number; timeoutMs?: number; keepDir?: string; log?: (m: string) => void } = {},
): Promise<ReproResult[]> {
  const root = ctx.changes.root;
  if (ctx.changes.headRef !== null) return []; // needs the reviewed code on disk
  const results: ReproResult[] = [];
  const targets = findings.filter((f) => f.source === 'llm' && (f.severity === 'P0' || f.severity === 'P1') && !isTestPath(f.file)).slice(0, opts.max ?? 5);
  for (const f of targets) {
    const fw = detectFramework(root, f.file);
    if (!fw) continue;
    const base = posix.basename(f.file).replace(/\.[^.]+$/, '');
    const testPath = posix.join(posix.dirname(f.file), fw.testName(base));
    const abs = join(root, testPath);
    if (existsSync(abs)) continue;
    const src = ctx.changes.newSnap.read(f.file) ?? '';
    const example = ctx.changes.newSnap
      .files()
      .filter((p) => isTestPath(p) && langFor(p)?.id === langFor(f.file)?.id)
      .sort((a, b) => (a.startsWith(posix.dirname(f.file)) ? -1 : 0) - (b.startsWith(posix.dirname(f.file)) ? -1 : 0))[0];
    const exampleText = example ? (ctx.changes.newSnap.read(example) ?? '').slice(0, 2500) : '';
    opts.log?.(`Writing a ${fw.id} repro for ${f.file}:${f.line}...`);
    let code = '';
    try {
      const r = await provider.complete({
        system: REPRO_SYSTEM,
        prompt: redactBlock(
          `Framework: ${fw.id}\nTest file path (relative to repo root): ${testPath}\nCode under test: ${f.file}\n\nReported bug at ${f.file}:${f.line}: ${f.title}\n${f.body}\n\n` +
            `Current contents of ${f.file}:\n\`\`\`\n${src.slice(0, 12000)}\n\`\`\`\n` +
            (exampleText ? `\nAn existing test in this repo, for conventions (${example}):\n\`\`\`\n${exampleText}\n\`\`\`\n` : ''),
        ),
        schema: REPRO_SCHEMA,
        purpose: 'chat',
        maxTokens: 8000,
      });
      code = String((r.json as { code?: string }).code ?? '').replace(/^```\w*\n|```\s*$/g, '');
    } catch (e) {
      opts.log?.(`repro generation failed: ${(e as Error).message}`);
      continue;
    }
    if (!code.trim()) continue;
    const t0 = Date.now();
    let out = '';
    let outcome: ReproResult['outcome'] = 'inconclusive';
    try {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, code);
      const c = fw.command(testPath);
      const r = await run(c.cmd, c.args, root, opts.timeoutMs ?? 90_000);
      out = r.out;
      outcome = classify(fw.id, r.code, r.out);
    } finally {
      try {
        unlinkSync(abs);
      } catch {
        // already gone
      }
    }
    if (opts.keepDir) {
      const keep = join(root, opts.keepDir, `${f.id}-${posix.basename(testPath)}`);
      mkdirSync(dirname(keep), { recursive: true });
      writeFileSync(keep, code);
    }
    results.push({ findingId: f.id, outcome, testPath, testCode: code, output: out.trim().split('\n').slice(-25).join('\n'), ms: Date.now() - t0 });
  }
  return results;
}
