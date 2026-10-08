import { afterEach, describe, expect, it } from 'vitest';
import { contractFindings } from '../src/analyzers/contracts.js';
import type { AnalysisContext } from '../src/analyzers/context.js';
import { computeImpact } from '../src/analyzers/impact.js';
import { analyzeHistory } from '../src/analyzers/history.js';
import { secretFindings } from '../src/analyzers/secrets.js';
import { suggestSplit } from '../src/analyzers/split.js';
import { loadConfig } from '../src/config.js';
import { parseUnifiedDiff } from '../src/diff.js';
import { collectChanges, type DiffMode } from '../src/git.js';
import { RepoIndex } from '../src/index/graph.js';
import { extractFacts } from '../src/index/extract.js';
import { tempRepo, type TempRepo } from './helpers.js';

let repo: TempRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

async function ctxFor(r: TempRepo, mode: DiffMode = { kind: 'working' }): Promise<AnalysisContext> {
  const changes = collectChanges(r.root, mode);
  const loaded = loadConfig(changes.oldSnap, changes.newSnap);
  const newIndex = await RepoIndex.build(changes.newSnap);
  const oldIndex = await RepoIndex.partial(
    changes.oldSnap,
    changes.files.filter((f) => f.status !== 'added').map((f) => f.oldPath ?? f.path),
  );
  return { changes, newIndex, oldIndex, loaded, reviewFiles: new Set(changes.files.map((f) => f.path)) };
}

describe('diff parser', () => {
  it('tracks new-side line numbers, renames and deletions', () => {
    const text = [
      'diff --git a/a.ts b/a.ts',
      'index 1..2 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,3 +1,4 @@',
      ' one',
      '-two',
      '+TWO',
      '+three',
      ' four',
      'diff --git a/old.py b/new.py',
      'similarity index 90%',
      'rename from old.py',
      'rename to new.py',
      'diff --git a/gone.go b/gone.go',
      'deleted file mode 100644',
      '--- a/gone.go',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-package x',
    ].join('\n');
    const files = parseUnifiedDiff(text);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['a.ts', 'modified'],
      ['new.py', 'renamed'],
      ['gone.go', 'deleted'],
    ]);
    expect([...files[0].added]).toEqual([2, 3]);
    expect([...files[0].removed]).toEqual([2]);
    expect(files[1].oldPath).toBe('old.py');
  });
});

describe('extractor', () => {
  it('reads defs, params and calls across languages', async () => {
    const ts = await extractFacts(
      'a.ts',
      `import { b } from './b';\nexport function charge(user: string, amount: number, currency = 'usd', ...rest: any[]) { return b(user); }\nconst f = (x?: number) => x;\nclass A { m(this: A, y: number) { this.m(1); } }`,
    );
    const charge = ts!.defs.find((d) => d.name === 'charge')!;
    expect(charge.params!.map((p) => [p.name, p.optional, p.variadic])).toEqual([
      ['user', false, false],
      ['amount', false, false],
      ['currency', true, false],
      ['rest', false, true],
    ]);
    expect(charge.exported).toBe(true);
    expect(ts!.defs.find((d) => d.name === 'f')!.params![0].optional).toBe(true);
    expect(ts!.defs.find((d) => d.name === 'm')!.params!.length).toBe(1);
    expect(ts!.imports[0]).toMatchObject({ module: './b', names: [{ imported: 'b', local: 'b' }] });
    expect(ts!.calls.find((c) => c.name === 'b')).toMatchObject({ positional: 1, inDef: 'charge' });

    const py = await extractFacts('a.py', `from .b import thing as t\nclass K:\n    def m(self, a, b=2, *args, c, **kw):\n        return t(a, key=1)\n`);
    expect(py!.defs.find((d) => d.name === 'm')!.params!.map((p) => p.name)).toEqual(['a', 'b', 'args', 'c', 'kw']);
    expect(py!.calls[0]).toMatchObject({ name: 't', positional: 1, keywords: ['key'] });

    const go = await extractFacts('a.go', `package x\nimport "fmt"\nfunc Add(a, b int, rest ...int) int { fmt.Println(a); return a }\n`);
    expect(go!.defs[0].params!.map((p) => [p.name, p.variadic])).toEqual([
      ['a', false],
      ['b', false],
      ['rest', true],
    ]);
    expect(go!.calls[0]).toMatchObject({ name: 'Println', qualifier: 'fmt' });

    const java = await extractFacts('A.java', `class A { int f(int a, String... more) { return g(a, 2); } }`);
    expect(java!.defs.find((d) => d.name === 'f')!.params!.map((p) => p.variadic)).toEqual([false, true]);

    const rb = await extractFacts('a.rb', `class Foo\n  def bar(a, b = 1, *rest)\n  end\nend\n`);
    expect(rb!.defs.find((d) => d.name === 'bar')!.params!.map((p) => [p.optional, p.variadic])).toEqual([
      [false, false],
      [true, false],
      [false, true],
    ]);
  });
});

describe('contract analyzer', () => {
  it('flags callers in untouched files after a signature change (TypeScript)', async () => {
    repo = tempRepo();
    repo.write({
      'src/billing.ts': `export function charge(user: string, amount: number) {\n  return { user, amount };\n}\n`,
      'src/checkout.ts': `import { charge } from './billing';\nexport function checkout(u: string) {\n  return charge(u, 10);\n}\n`,
      'src/admin/refund.ts': `import { charge } from '../billing';\nexport const refund = (u: string) => charge(u, -5);\n`,
    });
    repo.commit('init');
    repo.write({ 'src/billing.ts': `export function charge(user: string, amount: number, currency: string) {\n  return { user, amount, currency };\n}\n` });
    const ctx = await ctxFor(repo);
    const findings = contractFindings(ctx);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.rule).toBe('contract/stale-caller');
    expect(f.file).toBe('src/billing.ts');
    expect(f.evidence.map((e) => `${e.file}:${e.line}`).sort()).toEqual(['src/admin/refund.ts:2', 'src/billing.ts:1', 'src/checkout.ts:3']);
    expect(f.evidence.find((e) => e.file === 'src/checkout.ts')!.snippet).toBe('return charge(u, 10);');
  });

  it('does not flag when an added parameter is optional', async () => {
    repo = tempRepo();
    repo.write({
      'billing.py': `def charge(user, amount):\n    return user\n`,
      'checkout.py': `from billing import charge\n\ndef go(u):\n    return charge(u, 10)\n`,
    });
    repo.commit('init');
    repo.write({ 'billing.py': `def charge(user, amount, currency="usd"):\n    return user\n` });
    expect(contractFindings(await ctxFor(repo))).toHaveLength(0);
  });

  it('flags imports of a removed symbol and of a deleted module', async () => {
    repo = tempRepo();
    repo.write({
      'lib/util.ts': `export function slug(s: string) { return s; }\nexport function keep() {}\n`,
      'lib/old.ts': `export const x = 1;\n`,
      'app.ts': `import { slug, keep } from './lib/util';\nimport { x } from './lib/old';\nslug('a'); keep();\n`,
    });
    repo.commit('init');
    repo.write({ 'lib/util.ts': `export function keep() {}\n` });
    repo.remove('lib/old.ts');
    const rules = contractFindings(await ctxFor(repo)).map((f) => `${f.rule} ${f.file}:${f.line}`).sort();
    expect(rules).toEqual(['contract/dangling-reference app.ts:1', 'contract/missing-module app.ts:2']);
  });

  it('handles Go same-package calls after a removal', async () => {
    repo = tempRepo();
    repo.write({
      'go.mod': 'module example.com/m\n',
      'pkg/a.go': `package pkg\nfunc Helper(x int) int { return x }\n`,
      'pkg/b.go': `package pkg\nfunc Use() int { return Helper(1) }\n`,
    });
    repo.commit('init');
    repo.write({ 'pkg/a.go': `package pkg\n` });
    const f = contractFindings(await ctxFor(repo));
    expect(f.map((x) => `${x.rule} ${x.file}:${x.line}`)).toEqual(['contract/dangling-reference pkg/b.go:2']);
  });
});

describe('secrets', () => {
  it('finds and redacts keys, ignores placeholders', async () => {
    repo = tempRepo();
    repo.write({ 'a.ts': 'export const x = 1;\n' });
    repo.commit('init');
    const aws = 'AKIA' + 'IOSFODNN7EXAMPLQ'; // fake, built at runtime
    const secret = 'q8Zr2Lm9' + 'Xv4Tn7Wb1Kc5';
    repo.write({
      'a.ts': `export const x = 1;\nconst k = "${aws}";\nconst api_key = "changeme-please-now";\nconst client_secret = "${secret}";\n`,
    });
    const f = secretFindings(await ctxFor(repo));
    expect(f.map((x) => [x.line, x.severity])).toEqual([
      [2, 'P0'],
      [4, 'P1'],
    ]);
    expect(JSON.stringify(f)).not.toContain(aws);
    expect(JSON.stringify(f)).not.toContain(secret);
  });
});

describe('impact, history, split', () => {
  it('computes blast radius, reverts and reviewers', async () => {
    repo = tempRepo();
    repo.write({
      'src/auth/session.ts': `export function verify(t: string) { return t.length > 0; }\n`,
      'src/api.ts': `import { verify } from './auth/session';\nexport function handler(t: string) { return verify(t); }\n`,
      'src/api.test.ts': `import { verify } from './auth/session';\nverify('x');\n`,
    });
    repo.commit('init', { author: 'Ada', email: 'ada@example.com' });
    repo.write({ 'src/auth/session.ts': `export function verify(t: string) { return t.length > 1; }\n` });
    repo.commit('Revert "loosen token check"', { author: 'Ada', email: 'ada@example.com' });
    repo.write({ 'src/auth/session.ts': `export function verify(t: string) { return t.length > 2; }\n` });
    const ctx = await ctxFor(repo);
    const impact = computeImpact(ctx);
    expect(impact.entries[0]).toMatchObject({ symbol: 'verify', change: 'modified' });
    expect(impact.entries[0].callers.map((c) => c.file).sort()).toEqual(['src/api.test.ts', 'src/api.ts']);
    expect(impact.entries[0].testedBy).toEqual(['src/api.test.ts']);
    expect(impact.reach).toEqual(['src/api.test.ts', 'src/api.ts']);
    const h = analyzeHistory(ctx);
    expect(h.riskLevel).toBe('critical');
    expect(h.files[0].reverts).toHaveLength(1);
    expect(h.reviewers[0]).toMatchObject({ name: 'Ada' });
  });

  it('splits a large change along dependency lines', async () => {
    repo = tempRepo();
    repo.write({ 'README.md': 'x\n' });
    repo.commit('init');
    const files: Record<string, string> = {};
    for (let i = 0; i < 4; i++) files[`core/m${i}.ts`] = `export function m${i}() { return ${i}; }\n`;
    for (let i = 0; i < 4; i++) files[`ui/v${i}.ts`] = `import { m${i} } from '../core/m${i}';\nexport const v${i} = m${i}();\n`;
    files['docs/a.md'] = 'docs\n';
    repo.write(files);
    const ctx = await ctxFor(repo);
    ctx.loaded.config.split = { maxFiles: 3, maxLines: 5 };
    const plan = suggestSplit(ctx)!;
    expect(plan.parts.length).toBeGreaterThan(1);
    // Every part that depends on another comes after it.
    plan.parts.forEach((p, i) => p.dependsOn.forEach((d) => expect(d).toBeLessThanOrEqual(i)));
  });
});

describe('import and arity checks on added code', () => {
  it('flags an import of a name the module does not define (Python, like Sentry benchmark #1)', async () => {
    repo = tempRepo();
    repo.write({
      'src/app/api/paginator.py': `class CursorPaginator:\n    pass\n\nDEFAULT = 10\n`,
      'src/app/api/__init__.py': '',
      'src/app/api/endpoint.py': `from app.api.paginator import CursorPaginator\n`,
    });
    repo.commit('init');
    repo.write({ 'src/app/api/endpoint.py': `from app.api.paginator import CursorPaginator, OptimizedCursorPaginator, DEFAULT\n` });
    const f = contractFindings(await ctxFor(repo));
    expect(f.map((x) => `${x.rule} ${x.file}:${x.line} ${x.title}`)).toEqual([
      'contract/unknown-import src/app/api/endpoint.py:1 Imports `OptimizedCursorPaginator` from `app.api.paginator`, which does not define it',
    ]);
  });

  it('flags TS named imports that do not exist, but trusts export * barrels', async () => {
    repo = tempRepo();
    repo.write({
      'lib/a.ts': `export const one = 1;\nexport type Two = 2;\nexport { one as uno };\n`,
      'lib/index.ts': `export * from './a';\n`,
      'app.ts': `import { one } from './lib/a';\n`,
    });
    repo.commit('init');
    repo.write({ 'app.ts': `import { one, uno, Two, three } from './lib/a';\nimport { anything } from './lib';\n` });
    const f = contractFindings(await ctxFor(repo));
    expect(f.map((x) => x.title)).toEqual(['Imports `three` from `./lib/a`, which does not define it']);
  });

  it('flags a new call with the wrong arity (Java, like Keycloak benchmark #1) but not overloads', async () => {
    repo = tempRepo();
    repo.write({
      'src/Auth.java': `class Auth {\n  boolean passkeysEnabled(String user) { return true; }\n  void log(String a) {}\n  void log(String a, int b) {}\n  void run() {}\n}\n`,
    });
    repo.commit('init');
    repo.write({
      'src/Auth.java': `class Auth {\n  boolean passkeysEnabled(String user) { return true; }\n  void log(String a) {}\n  void log(String a, int b) {}\n  void run() {\n    if (passkeysEnabled()) { log("x", 1); }\n  }\n}\n`,
    });
    const f = contractFindings(await ctxFor(repo));
    expect(f.map((x) => `${x.rule} ${x.line} ${x.title}`)).toEqual(['contract/bad-arity 6 This call to `passkeysEnabled()` is missing `user`']);
  });

  it('skips decorated Python functions and plain JavaScript', async () => {
    repo = tempRepo();
    repo.write({ 'm.py': `import click\n\n@click.command()\ndef cli(name):\n    pass\n`, 'a.js': `function f(a, b) {}\n` });
    repo.commit('init');
    repo.write({ 'm.py': `import click\n\n@click.command()\ndef cli(name):\n    pass\n\ncli()\n`, 'a.js': `function f(a, b) {}\nf(1);\n` });
    expect(contractFindings(await ctxFor(repo))).toEqual([]);
  });
});

describe('anonymous callees', () => {
  it('never treats an immediately-invoked function as a call to something inside it', async () => {
    const go = await extractFacts('a.go', `package x\nfunc f(a int, b int) {}\nfunc g() {\n\tgo func() {\n\t\tf(1, 2)\n\t}()\n}\n`);
    expect(go!.calls.map((c) => `${c.name}@${c.line}`)).toEqual(['f@5']);
    const js = await extractFacts('a.ts', `function h(a: number) {}\n(function () { h(1); })();\n(() => h(2))();\nconst o = { m() {} };\no.m();\n`);
    expect(js!.calls.map((c) => `${c.name}@${c.line}`).sort()).toEqual(['h@2', 'h@3', 'm@5']);
    const py = await extractFacts('a.py', `def k(a):\n    pass\n(lambda: k(1))()\n`);
    expect(py!.calls.map((c) => c.name)).toEqual(['k']);
    const c = await extractFacts('a.c', `int add(int a, int b) { return a + b; }\nint main(void) { return add(1, 2); }\n`);
    expect(c!.defs.map((d) => `${d.name}/${d.params?.length}`)).toEqual(['add/2', 'main/0']);
    expect(c!.calls.map((x) => x.name)).toEqual(['add']);
  });
});

describe('secret heuristics', () => {
  it('ignores constants named like secrets, keeps real-looking credentials', async () => {
    const { looksLikeSecretValue } = await import('../src/redact.js');
    expect(looksLikeSecretValue('USER_SET_BEFORE_USERNAME_PASSWORD_AUTH', 'USER_SET_BEFORE_USERNAME_PASSWORD_AUTH')).toBe(false);
    expect(looksLikeSecretValue('PASSWORD_FIELD', 'password_confirmation_input')).toBe(false);
    expect(looksLikeSecretValue('tokenEndpoint', 'https://example.com/oauth/token')).toBe(false);
    expect(looksLikeSecretValue('authHeader', 'Authorization')).toBe(false);
    expect(looksLikeSecretValue('client_secret', 'q8Zr2Lm9' + 'Xv4Tn7Wb1Kc5')).toBe(true);
    expect(looksLikeSecretValue('apiKey', 'Zm9vYmFyYmF6cXV4' + 'UXVpY2tCcm93bkZveEp1bXBz')).toBe(true);
  });
});

describe('toolchain proof', () => {
  it('reports tsc errors on added lines only, and skips pre-existing ones', async () => {
    const { symlinkSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { runToolchain } = await import('../src/analyzers/toolchain.js');
    repo = tempRepo();
    repo.write({
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2020', module: 'commonjs' }, include: ['src'] }),
      'src/a.ts': `export function add(a: number, b: number) { return a + b; }\nexport const old: number = 'already broken';\n`,
      '.gitignore': 'node_modules\n',
    });
    mkdirSync(join(repo.root, 'node_modules'), { recursive: true });
    symlinkSync(join(__dirname, '..', 'node_modules', 'typescript'), join(repo.root, 'node_modules', 'typescript'));
    repo.commit('init');
    repo.write({ 'src/a.ts': `export function add(a: number, b: number) { return a + b; }\nexport const old: number = 'already broken';\nexport const sum: string = add(1, 2);\n` });
    const { findings, results } = await runToolchain(await ctxFor(repo));
    expect(results[0]).toMatchObject({ tool: 'tsc', ran: true });
    expect(results[0].diagnostics.length).toBe(2); // the old error and the new one
    expect(findings.map((f) => `${f.file}:${f.line} ${f.rule}`)).toEqual(['src/a.ts:3 toolchain/tsc']);
    expect(findings[0].title).toContain("Type 'number' is not assignable to type 'string'");
  });

  it('parses go vet and ruff output', async () => {
    const { parseGoVet, parseRuff } = await import('../src/analyzers/toolchain.js');
    expect(
      parseGoVet(`# github.com/x/pkg/rest\nvet: pkg/rest/mode3.go:50:2: undefined: metricsEndpoint\npkg/rest/a.go:12:5: fmt.Sprintf call has arguments but no formatting directives\n`),
    ).toEqual([
      { file: 'pkg/rest/mode3.go', line: 50, code: 'govet', message: 'undefined: metricsEndpoint' },
      { file: 'pkg/rest/a.go', line: 12, code: 'govet', message: 'fmt.Sprintf call has arguments but no formatting directives' },
    ]);
    expect(parseRuff(`[{"filename":"/r/src/x.py","location":{"row":4,"column":1},"code":"F821","message":"Undefined name \`foo\`"}]`, '/r')).toEqual([
      { file: 'src/x.py', line: 4, code: 'F821', message: 'Undefined name `foo`' },
    ]);
  });
});
