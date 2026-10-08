import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import picomatch from 'picomatch';
import type { Snapshot } from '../git.js';
import { extractFacts, type CallSite, type FileFacts, type ImportRef, type SymbolDef } from './extract.js';
import { DEFAULT_IGNORES, langFor } from './languages.js';

export interface Resolved {
  file: string;
  def: SymbolDef;
  confidence: number;
  via: 'import' | 'same-file' | 'same-package' | 'receiver' | 'unique-name';
}

export interface CallerRef {
  file: string;
  call: CallSite;
  confidence: number;
  via: Resolved['via'];
}

export interface IndexOptions {
  ignore?: string[];
  maxFileBytes?: number;
  maxFiles?: number;
  cacheDir?: string;
  onProgress?: (done: number, total: number) => void;
}

const CACHE_VERSION = 8;

// Names too generic to resolve by uniqueness alone.
const COMMON = new Set(
  'get set put add run call init main start stop open close read write load save send update create delete remove find map filter reduce apply bind then catch handle process parse render build next emit log info warn error debug test check validate execute push pop keys values items copy clone equals hash toString valueOf constructor new len size count'.split(
    ' ',
  ),
);

const PY_STDLIB = new Set(
  'abc argparse array ast asyncio base64 binascii bisect builtins bz2 calendar cgi cmath codecs collections colorsys concurrent configparser contextlib contextvars copy copyreg cProfile csv ctypes curses dataclasses datetime decimal difflib dis email encodings enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc getopt getpass gettext glob graphlib gzip hashlib heapq hmac html http imaplib importlib inspect io ipaddress itertools json keyword linecache locale logging lzma mailbox marshal math mimetypes mmap multiprocessing netrc numbers operator optparse os pathlib pdb pickle pkgutil platform plistlib poplib posixpath pprint profile pstats pty pwd queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtplib socket socketserver sqlite3 ssl stat statistics string stringprep struct subprocess sys sysconfig syslog tarfile tempfile termios textwrap threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle types typing typing_extensions unicodedata unittest urllib uuid venv warnings wave weakref webbrowser wsgiref xml xmlrpc zipapp zipfile zipimport zlib zoneinfo __future__'.split(' '),
);

const JS_EXTS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

export class RepoIndex {
  readonly facts = new Map<string, FileFacts>();
  private defsByName = new Map<string, { file: string; def: SymbolDef }[]>();
  private callsByName = new Map<string, { file: string; call: CallSite }[]>();
  private dirFiles = new Map<string, string[]>();
  private moduleCache = new Map<string, string[]>();
  readonly fileSet: Set<string>;
  stats = { files: 0, parsed: 0, cached: 0, skipped: 0, ms: 0 };

  private constructor(readonly snap: Snapshot, files: string[]) {
    this.fileSet = new Set(files);
    for (const f of files) {
      const d = posix.dirname(f);
      const arr = this.dirFiles.get(d) ?? [];
      arr.push(f);
      this.dirFiles.set(d, arr);
    }
  }

  static async build(snap: Snapshot, opts: IndexOptions = {}): Promise<RepoIndex> {
    const t0 = Date.now();
    const isIgnored = picomatch([...DEFAULT_IGNORES, ...(opts.ignore ?? [])], { dot: true });
    const all = snap.files();
    const candidates = all.filter((f) => langFor(f) && !isIgnored(f)).slice(0, opts.maxFiles ?? 30000);
    const idx = new RepoIndex(snap, all);
    idx.stats.files = candidates.length;

    const cachePath = opts.cacheDir ? join(opts.cacheDir, `facts-v${CACHE_VERSION}.json`) : null;
    let cache: Record<string, FileFacts> = {};
    if (cachePath && existsSync(cachePath)) {
      try {
        cache = JSON.parse(readFileSync(cachePath, 'utf8'));
      } catch {
        cache = {};
      }
    }
    const nextCache: Record<string, FileFacts> = {};
    const contents = snap.readMany(candidates);
    const maxBytes = opts.maxFileBytes ?? 400_000;
    let done = 0;
    for (const f of candidates) {
      done++;
      if (opts.onProgress && done % 250 === 0) opts.onProgress(done, candidates.length);
      const src = contents.get(f);
      if (src == null || src.length > maxBytes) {
        idx.stats.skipped++;
        continue;
      }
      const key = createHash('sha1').update(f).update('\0').update(src).digest('hex');
      let facts = cache[key];
      if (facts) idx.stats.cached++;
      else {
        facts = (await extractFacts(f, src)) ?? undefined!;
        if (!facts) continue;
        idx.stats.parsed++;
      }
      nextCache[key] = facts;
      idx.add(f, facts);
    }
    if (cachePath) {
      try {
        mkdirSync(dirname(cachePath), { recursive: true });
        writeFileSync(cachePath, JSON.stringify(nextCache));
      } catch {
        // Cache is an optimization only.
      }
    }
    idx.stats.ms = Date.now() - t0;
    return idx;
  }

  /** Index a handful of files from a snapshot without walking the whole repo (used for the "old" side). */
  static async partial(snap: Snapshot, paths: string[]): Promise<RepoIndex> {
    const idx = new RepoIndex(snap, snap.files());
    const contents = snap.readMany(paths.filter((p) => langFor(p)));
    for (const [f, src] of contents) {
      if (src == null) continue;
      const facts = await extractFacts(f, src);
      if (facts) idx.add(f, facts);
    }
    return idx;
  }

  private add(file: string, facts: FileFacts) {
    this.facts.set(file, facts);
    for (const def of facts.defs) {
      const arr = this.defsByName.get(def.name) ?? [];
      arr.push({ file, def });
      this.defsByName.set(def.name, arr);
    }
    for (const call of facts.calls) {
      const arr = this.callsByName.get(call.name) ?? [];
      arr.push({ file, call });
      this.callsByName.set(call.name, arr);
    }
  }

  defsIn(file: string, name?: string): SymbolDef[] {
    const f = this.facts.get(file);
    if (!f) return [];
    return name ? f.defs.filter((d) => d.name === name) : f.defs;
  }

  /** The innermost definition that contains a line. */
  enclosingDef(file: string, line: number): SymbolDef | undefined {
    let best: SymbolDef | undefined;
    for (const d of this.defsIn(file)) {
      if (d.line <= line && line <= d.endLine && (!best || d.endLine - d.line < best.endLine - best.line)) best = d;
    }
    return best;
  }

  allDefs(name: string): { file: string; def: SymbolDef }[] {
    return this.defsByName.get(name) ?? [];
  }

  callsNamed(name: string): { file: string; call: CallSite }[] {
    return this.callsByName.get(name) ?? [];
  }

  importsOf(file: string): ImportRef[] {
    return this.facts.get(file)?.imports ?? [];
  }

  /** Resolve an import specifier to repository files. Returns [] for external packages. */
  resolveModule(fromFile: string, module: string): string[] {
    const key = `${fromFile}\0${module}`;
    const hit = this.moduleCache.get(key);
    if (hit) return hit;
    const lang = langFor(fromFile)?.id;
    let out: string[] = [];
    if (lang === 'typescript' || lang === 'tsx' || lang === 'javascript') out = this.resolveJs(fromFile, module);
    else if (lang === 'python') out = this.resolvePython(fromFile, module);
    else if (lang === 'go') out = this.resolveGo(module);
    else if (lang === 'java' || lang === 'kotlin') out = this.resolveJava(module);
    else if (lang === 'ruby') out = this.tryPaths([posix.join(posix.dirname(fromFile), module) + '.rb', module + '.rb']);
    this.moduleCache.set(key, out);
    return out;
  }

  private tryPaths(paths: string[]): string[] {
    for (const p of paths) {
      const n = posix.normalize(p).replace(/^\.\//, '');
      if (this.fileSet.has(n)) return [n];
    }
    return [];
  }

  private resolveJs(fromFile: string, module: string): string[] {
    let base: string | null = null;
    if (module.startsWith('.')) base = posix.join(posix.dirname(fromFile), module);
    else if (module.startsWith('@/') || module.startsWith('~/')) base = module.slice(2);
    else if (module.startsWith('src/')) base = module;
    if (base === null) return [];
    const stems = [base];
    // ESM TypeScript imports name the emitted .js file.
    const m = base.match(/^(.*)\.(m|c)?jsx?$/);
    if (m) stems.push(m[1]);
    const candidates: string[] = [];
    for (const s of stems) {
      candidates.push(s);
      for (const e of JS_EXTS) candidates.push(s + e);
      for (const e of JS_EXTS) candidates.push(posix.join(s, 'index' + e));
    }
    if (module.startsWith('@/') || module.startsWith('~/')) {
      for (const c of [...candidates]) candidates.push('src/' + c, 'app/' + c);
    }
    return this.tryPaths(candidates);
  }

  private resolvePython(fromFile: string, module: string): string[] {
    const dots = module.match(/^\.*/)?.[0].length ?? 0;
    const rest = module.slice(dots).replace(/\./g, '/');
    if (dots > 0) {
      let dir = posix.dirname(fromFile);
      for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
      const stem = rest ? posix.join(dir, rest) : dir;
      return this.tryPaths([stem + '.py', posix.join(stem, '__init__.py'), stem + '.pyi']);
    }
    const top = rest.split('/')[0];
    if (PY_STDLIB.has(top)) return [];
    // Absolute imports resolve only against source roots: the repo root and any
    // directory that directly holds a top-level package (src/, lib/, backend/...).
    for (const root of this.pythonRoots()) {
      const stem = root ? `${root}/${rest}` : rest;
      const hit = this.tryPaths([stem + '.py', posix.join(stem, '__init__.py')]);
      if (hit.length) return hit;
    }
    return [];
  }

  private pyRoots: string[] | null = null;
  private pythonRoots(): string[] {
    if (this.pyRoots) return this.pyRoots;
    const roots = new Set<string>(['']);
    for (const f of this.fileSet) {
      if (!f.endsWith('/__init__.py')) continue;
      const pkg = posix.dirname(f);
      const parent = posix.dirname(pkg);
      // A package whose parent is not itself a package sits at a source root.
      if (!this.fileSet.has(posix.join(parent, '__init__.py'))) {
        // Namespace packages (PEP 420) have no __init__.py, so every ancestor may be a root too.
        for (let d = parent; d !== '.' && d !== ''; d = posix.dirname(d)) roots.add(d);
      }
    }
    // Test directories and vendored copies are not import roots.
    this.pyRoots = [...roots].filter((r) => !/(^|\/)(tests?|node_modules|vendor|site-packages|\.venv|venv)(\/|$)/.test(r)).sort((a, b) => a.length - b.length);
    return this.pyRoots;
  }

  private resolveGo(module: string): string[] {
    for (const [dir, files] of this.dirFiles) {
      if (dir !== '.' && (module === dir || module.endsWith('/' + dir))) {
        return files.filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'));
      }
    }
    return [];
  }

  private resolveJava(module: string): string[] {
    const parts = module.replace(/\.\*$/, '').split('.');
    for (let n = parts.length; n > 1; n--) {
      const suffix = parts.slice(0, n).join('/');
      for (const ext of ['.java', '.kt']) {
        for (const f of this.fileSet) if (f.endsWith('/' + suffix + ext) || f === suffix + ext) return [f];
      }
    }
    return [];
  }

  /** Find where `name` is defined when imported from `file`, following re-exports. */
  resolveExport(file: string, name: string, depth = 0): { file: string; def: SymbolDef }[] {
    if (depth > 6) return [];
    const own = this.defsIn(file, name);
    if (own.length) return own.map((def) => ({ file, def }));
    for (const imp of this.importsOf(file)) {
      if (!imp.reexport && langFor(file)?.id !== 'python') continue;
      for (const n of imp.names) {
        if (n.local === name || (n.imported === '*' && n.local === '*')) {
          const target = n.imported === '*' ? name : n.imported;
          for (const t of this.resolveModule(file, imp.module)) {
            const r = this.resolveExport(t, target, depth + 1);
            if (r.length) return r;
          }
        }
      }
    }
    return [];
  }

  /** Candidate definitions for a call site. Highest-confidence strategies first. */
  resolveCall(file: string, call: CallSite): Resolved[] {
    const lang = langFor(file)?.id;
    const out: Resolved[] = [];
    const push = (list: { file: string; def: SymbolDef }[], confidence: number, via: Resolved['via']) => {
      for (const r of list) if (r.def.kind !== 'class' || true) out.push({ ...r, confidence, via });
    };
    const q = call.qualifier;
    const imports = this.importsOf(file);

    if (q) {
      if (/^(this|self|cls|super|@)$/.test(q) || q.startsWith('this.') || q.startsWith('self.')) {
        push(this.defsIn(file, call.name).map((def) => ({ file, def })), 0.85, 'receiver');
        if (out.length) return out;
      }
      for (const imp of imports) {
        for (const n of imp.names) {
          if (n.local !== q) continue;
          const targets = this.resolveModule(file, imp.module);
          if (n.imported === '*' || n.imported === 'default') {
            for (const t of targets) push(this.resolveExport(t, call.name), 0.95, 'import');
            if (lang === 'python' && !targets.length) {
              // `import pkg.mod as m` where the submodule holds the def
              for (const t of this.resolveModule(file, imp.module + '.' + call.name)) push(this.defsIn(t).map((def) => ({ file: t, def })), 0.6, 'import');
            }
          } else {
            // `from pkg import mod` then `mod.fn()`
            for (const t of this.resolveModule(file, `${imp.module}.${n.imported}`)) push(this.resolveExport(t, call.name), 0.95, 'import');
            // Java/TS: imported class, static or instance method on it.
            for (const t of targets) push(this.defsIn(t, call.name).map((def) => ({ file: t, def })), 0.85, 'import');
          }
        }
      }
      if (out.length) return out;
    } else {
      for (const imp of imports) {
        for (const n of imp.names) {
          if (n.local !== call.name || n.imported === '*') continue;
          const imported = n.imported === 'default' ? call.name : n.imported;
          for (const t of this.resolveModule(file, imp.module)) {
            const r = this.resolveExport(t, imported);
            if (r.length) push(r, 0.95, 'import');
            else if (n.imported === 'default') push(this.defsIn(t).filter((d) => d.exported).slice(0, 1).map((def) => ({ file: t, def })), 0.7, 'import');
          }
        }
      }
      if (out.length) return out;
      push(this.defsIn(file, call.name).map((def) => ({ file, def })), 0.9, 'same-file');
      if (out.length) return out;
      if (lang === 'go' || lang === 'java' || lang === 'kotlin' || lang === 'csharp' || lang === 'scala' || lang === 'swift' || lang === 'c' || lang === 'cpp') {
        for (const f of this.dirFiles.get(posix.dirname(file)) ?? []) {
          if (f !== file) push(this.defsIn(f, call.name).map((def) => ({ file: f, def })), 0.85, 'same-package');
        }
        if (out.length) return out;
      }
    }

    // Last resort: the name is defined exactly once in the repository.
    const all = this.allDefs(call.name).filter((d) => d.def.kind !== 'class' || /^[A-Z]/.test(call.name));
    if (all.length === 1 && call.name.length >= 4 && !COMMON.has(call.name)) {
      const sameLangFamily = langFamily(langFor(all[0].file)?.id) === langFamily(lang);
      if (sameLangFamily) push(all, q ? 0.55 : 0.65, 'unique-name');
    }
    return out;
  }

  /** Every call site that resolves to `name` defined in `file`. */
  callersOf(file: string, name: string, minConfidence = 0.5): CallerRef[] {
    const out: CallerRef[] = [];
    for (const { file: cf, call } of this.callsNamed(name)) {
      const res = this.resolveCall(cf, call);
      const hit = res.find((r) => r.file === file && r.def.name === name);
      if (hit && hit.confidence >= minConfidence) out.push({ file: cf, call, confidence: hit.confidence, via: hit.via });
    }
    return out;
  }

  /** Files that import `file` (directly). */
  importersOf(file: string): { file: string; imp: ImportRef }[] {
    const out: { file: string; imp: ImportRef }[] = [];
    for (const [f, facts] of this.facts) {
      for (const imp of facts.imports) {
        if (this.resolveModule(f, imp.module).includes(file)) out.push({ file: f, imp });
      }
    }
    return out;
  }
}

function langFamily(id?: string): string {
  if (!id) return '';
  if (id === 'typescript' || id === 'tsx' || id === 'javascript') return 'js';
  if (id === 'c' || id === 'cpp') return 'c';
  if (id === 'java' || id === 'kotlin' || id === 'scala') return 'jvm';
  return id;
}

/** Arity check: does a call site satisfy a parameter list? */
export function arityMismatch(params: SymbolDef['params'], call: CallSite): { kind: 'too-few' | 'too-many'; required: number; max: number; got: number; missing: string[] } | null {
  if (!params || call.spread) return null;
  const variadic = params.some((p) => p.variadic);
  const fixed = params.filter((p) => !p.variadic);
  const required = fixed.filter((p) => !p.optional);
  const got = call.positional + call.keywords.length;
  if (!variadic && got > fixed.length) {
    return { kind: 'too-many', required: required.length, max: fixed.length, got, missing: [] };
  }
  const missing: string[] = [];
  required.forEach((p, i) => {
    const posIndex = fixed.indexOf(p);
    const covered = posIndex < call.positional || call.keywords.includes(p.name) || (i < call.positional && posIndex < 0);
    if (!covered) missing.push(p.name);
  });
  // Named arguments can satisfy parameters in any order; only count the shortfall.
  if (missing.length && got < required.length) {
    return { kind: 'too-few', required: required.length, max: variadic ? Infinity : fixed.length, got, missing };
  }
  if (missing.length && call.keywords.length === 0) {
    return { kind: 'too-few', required: required.length, max: variadic ? Infinity : fixed.length, got, missing };
  }
  return null;
}
