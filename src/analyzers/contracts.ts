// Contract checks: the class of bug that diff-only reviewers miss because the
// broken code is in a file the PR never touched.
//
//  1. stale-caller   a function's parameters changed and an existing caller
//                    still passes the old number of arguments
//  2. dangling-import a symbol was removed/renamed but another file still imports it
//  3. missing-module  a file was deleted/moved but another file still imports its path

import { posix } from 'node:path';
import { arityMismatch, type CallerRef } from '../index/graph.js';
import type { Param, SymbolDef } from '../index/extract.js';
import { langFor } from '../index/languages.js';
import type { Finding } from '../types.js';
import { evidence, finalize, type AnalysisContext } from './context.js';

const STATIC_LANGS = new Set(['typescript', 'tsx', 'go', 'java', 'kotlin', 'rust', 'csharp', 'c', 'cpp', 'swift', 'scala']);

function sigKey(params: Param[] | null): string {
  if (!params) return '?';
  return params.map((p) => (p.variadic ? '...' : p.optional ? '?' : '!')).join('');
}

function arityText(params: Param[]): string {
  const fixed = params.filter((p) => !p.variadic);
  const req = fixed.filter((p) => !p.optional).length;
  const variadic = params.some((p) => p.variadic);
  if (variadic) return `at least ${req} argument${req === 1 ? '' : 's'}`;
  if (req === fixed.length) return `${req} argument${req === 1 ? '' : 's'}`;
  return `${req}-${fixed.length} arguments`;
}

function defKey(d: SymbolDef): string {
  return `${d.container ?? ''}::${d.name}`;
}

export function contractFindings(ctx: AnalysisContext): Finding[] {
  const out: Finding[] = [];
  const { changes, newIndex, oldIndex } = ctx;
  const newSnap = changes.newSnap;
  const changedPaths = new Set(changes.files.map((f) => f.path));

  for (const fc of changes.files) {
    if (fc.status === 'deleted' || fc.binary) continue;
    const lang = langFor(fc.path)?.id;
    if (!lang || !ctx.reviewFiles.has(fc.path)) continue;
    const oldPath = fc.oldPath ?? fc.path;
    if (newIndex.facts.get(fc.path)?.syntaxErrors || oldIndex.facts.get(oldPath)?.syntaxErrors) continue;
    const oldDefs = fc.status === 'added' ? [] : oldIndex.defsIn(oldPath).filter((d) => d.kind !== 'class');
    const newDefs = newIndex.defsIn(fc.path).filter((d) => d.kind !== 'class');
    const newByKey = new Map<string, SymbolDef[]>();
    for (const d of newDefs) newByKey.set(defKey(d), [...(newByKey.get(defKey(d)) ?? []), d]);

    // 1. Signature changes with stale callers.
    const seen = new Set<string>();
    for (const od of oldDefs) {
      const key = defKey(od);
      if (seen.has(key)) continue;
      seen.add(key);
      const candidates = newByKey.get(key);
      if (!candidates || candidates.length !== 1) continue; // removed, or overloaded: handled below / skipped
      const nd = candidates[0];
      const olds = oldDefs.filter((d) => defKey(d) === key);
      if (olds.length !== 1 || !od.params || !nd.params) continue;
      if (sigKey(od.params) === sigKey(nd.params)) continue;

      const overloads = newIndex.defsIn(fc.path, nd.name);
      const callers: CallerRef[] = newIndex.callersOf(fc.path, nd.name, 0.6).filter((c) => {
        if (c.call.inDef === nd.name && c.file === fc.path) return false; // recursion inside the def itself
        // Only blame this change for calls that fit the old signature and break on the new one.
        if (arityMismatch(od.params, c.call) !== null) return false;
        return overloads.every((o) => arityMismatch(o.params, c.call) !== null);
      });
      if (!callers.length) continue;

      const stale = callers.slice(0, 12);
      const untouched = stale.filter((c) => !changedPaths.has(c.file)).length;
      const wontCompile = STATIC_LANGS.has(lang);
      const conf = Math.min(...stale.map((c) => c.confidence));
      out.push(
        finalize(
          {
            source: 'static',
            rule: 'contract/stale-caller',
            severity: 'P1',
            category: 'contract',
            file: fc.path,
            line: nd.line,
            title: `\`${nd.name}()\` now takes ${arityText(nd.params)}, but ${callers.length} caller${callers.length === 1 ? '' : 's'} still pass${callers.length === 1 ? 'es' : ''} the old shape`,
            body:
              `The parameter list of \`${nd.name}\` changed in this diff (was ${arityText(od.params)}, now ${arityText(nd.params)}). ` +
              `${callers.length === 1 ? 'This call site was' : 'These call sites were'} not updated` +
              (untouched ? `, and ${untouched} of them ${untouched === 1 ? 'is' : 'are'} in files this change doesn't touch, so a diff-only review won't see ${untouched === 1 ? 'it' : 'them'}` : '') +
              `. ${wontCompile ? 'This will fail to compile.' : 'This fails at runtime when the call runs.'}`,
            evidence: [
              evidence(newSnap, fc.path, nd.line, 'new signature'),
              ...stale.map((c) => {
                const m = arityMismatch(nd.params, c.call)!;
                const what = m.kind === 'too-many' ? `passes ${m.got}, max is ${m.max}` : `passes ${m.got}${m.missing.length ? `, missing \`${m.missing.join('`, `')}\`` : ''}`;
                return evidence(newSnap, c.file, c.call.line, `caller ${what}${changedPaths.has(c.file) ? '' : ' (file not in this diff)'}`);
              }),
            ],
            confidence: conf,
            verification: 'deterministic',
          },
          newSnap,
        ),
      );
    }
  }

  // 2 + 3. Removed symbols and moved/deleted modules still referenced elsewhere.
  const removedByFile = new Map<string, Set<string>>();
  for (const fc of changes.files) {
    if (!langFor(fc.path) && !langFor(fc.oldPath ?? '')) continue;
    const oldPath = fc.oldPath ?? fc.path;
    if (fc.status === 'added') continue;
    // A file that doesn't parse cleanly can look like it lost definitions it still has.
    if (newIndex.facts.get(fc.path)?.syntaxErrors || oldIndex.facts.get(oldPath)?.syntaxErrors) continue;
    const oldNames = new Set(oldIndex.defsIn(oldPath).filter((d) => !d.container).map((d) => d.name));
    const newNames = fc.status === 'deleted' ? new Set<string>() : new Set(newIndex.defsIn(fc.path).filter((d) => !d.container).map((d) => d.name));
    const removed = new Set([...oldNames].filter((n) => !newNames.has(n)));
    if (removed.size && fc.status !== 'deleted') removedByFile.set(fc.path, removed);
  }
  const goneFiles = new Set(
    changes.files.filter((f) => f.status === 'deleted' || f.status === 'renamed').map((f) => (f.status === 'renamed' ? f.oldPath! : f.path)),
  );

  if (removedByFile.size || goneFiles.size) {
    for (const [g, facts] of newIndex.facts) {
      for (const imp of facts.imports) {
        const targets = newIndex.resolveModule(g, imp.module);
        // 3. import path points at a file that this change deleted or moved
        if (!targets.length && goneFiles.size && /^\.|^@\/|^~\//.test(imp.module) === true) {
          const oldTargets = oldIndex.resolveModule(g, imp.module).filter((t) => goneFiles.has(t));
          if (oldTargets.length) {
            const moved = changes.files.find((f) => f.status === 'renamed' && f.oldPath === oldTargets[0]);
            out.push(
              finalize(
                {
                  source: 'static',
                  rule: 'contract/missing-module',
                  severity: 'P0',
                  category: 'contract',
                  file: g,
                  line: imp.line,
                  title: `Imports \`${imp.module}\`, which this change ${moved ? `moved to \`${moved.path}\`` : 'deleted'}`,
                  body: `\`${g}\` still imports \`${imp.module}\`, which resolved to \`${oldTargets[0]}\` before this change. ${moved ? `The file now lives at \`${moved.path}\`; update the import path.` : 'The file is gone, so this import fails.'}`,
                  evidence: [evidence(newSnap, g, imp.line, 'import that no longer resolves')],
                  confidence: 0.95,
                  verification: 'deterministic',
                },
                newSnap,
              ),
            );
          }
          continue;
        }
        // 2. named import of a symbol that was removed from its module
        for (const t of targets) {
          const removed = removedByFile.get(t);
          if (!removed) continue;
          for (const n of imp.names) {
            const name = n.imported === '*' || n.imported === 'default' ? null : n.imported;
            if (name && removed.has(name) && newIndex.resolveExport(t, name).length === 0) {
              out.push(danglingFinding(ctx, g, imp.line, name, t, 'imports'));
            }
            // namespace import: look for ns.removedName() calls
            if (n.imported === '*' && n.local !== '*') {
              for (const call of facts.calls) {
                if (call.qualifier === n.local && removed.has(call.name) && newIndex.resolveExport(t, call.name).length === 0) {
                  out.push(danglingFinding(ctx, g, call.line, call.name, t, 'calls'));
                }
              }
            }
          }
        }
      }
    }
    // Same-package languages (Go, Java...): unqualified calls to a removed function with no remaining definition.
    for (const [file, removed] of removedByFile) {
      const lang = langFor(file)?.id;
      if (lang !== 'go') continue;
      const dir = posix.dirname(file);
      for (const name of removed) {
        const stillDefined = newIndex.allDefs(name).some((d) => posix.dirname(d.file) === dir);
        if (stillDefined) continue;
        for (const { file: cf, call } of newIndex.callsNamed(name)) {
          if (posix.dirname(cf) === dir && !call.qualifier) out.push(danglingFinding(ctx, cf, call.line, name, file, 'calls'));
        }
      }
    }
  }

  // A bad call that is just a stale caller of a signature changed in this diff is already reported.
  const staleSites = new Set(out.filter((f) => f.rule === 'contract/stale-caller').flatMap((f) => f.evidence.map((e) => `${e.file}:${e.line}`)));
  out.push(...unknownImportFindings(ctx), ...newCallArityFindings(ctx).filter((f) => !staleSites.has(`${f.file}:${f.line}`)));

  // De-duplicate by id.
  const byId = new Map<string, Finding>();
  for (const f of out) if (!byId.has(f.id)) byId.set(f.id, f);
  return [...byId.values()];
}

/** 4. An added import names something the target module does not export. */
function unknownImportFindings(ctx: AnalysisContext): Finding[] {
  const out: Finding[] = [];
  const { changes, newIndex } = ctx;
  for (const fc of changes.files) {
    if (fc.status === 'deleted' || !ctx.reviewFiles.has(fc.path)) continue;
    const lang = langFor(fc.path)?.id;
    if (lang !== 'python' && lang !== 'typescript' && lang !== 'tsx' && lang !== 'javascript') continue;
    for (const imp of newIndex.importsOf(fc.path)) {
      if (!fc.added.has(imp.line) || imp.reexport && lang !== 'python') continue;
      const targets = newIndex.resolveModule(fc.path, imp.module);
      if (targets.length !== 1) continue;
      const t = targets[0];
      const facts = newIndex.facts.get(t);
      if (!facts || facts.wildcard || !facts.names || facts.parseError || facts.syntaxErrors) continue;
      for (const n of imp.names) {
        if (n.imported === '*' || n.imported === 'default') continue;
        if (facts.names.includes(n.imported)) continue;
        if (newIndex.resolveExport(t, n.imported).length) continue;
        // `from pkg import submodule`
        if (lang === 'python' && newIndex.resolveModule(fc.path, `${imp.module}.${n.imported}`).length) continue;
        out.push(
          finalize(
            {
              source: 'static',
              rule: 'contract/unknown-import',
              severity: 'P0',
              category: 'contract',
              file: fc.path,
              line: imp.line,
              title: `Imports \`${n.imported}\` from \`${imp.module}\`, which does not define it`,
              body: `\`${t}\` has no top-level \`${n.imported}\`${lang === 'python' ? ', so this raises ImportError when the module loads' : ', so this fails to compile or is undefined at runtime'}. It may be misspelled, or the definition was never added.`,
              evidence: [evidence(changes.newSnap, fc.path, imp.line, 'import added in this change'), evidence(changes.newSnap, t, 1, `\`${t}\` (checked every top-level name)`)],
              confidence: 0.9,
              verification: 'deterministic',
            },
            changes.newSnap,
          ),
        );
      }
    }
  }
  return out;
}

const OVERLOADING = new Set(['java', 'kotlin', 'csharp', 'scala', 'cpp', 'swift']);
const SAFE_DECORATORS = /^(staticmethod|classmethod|property|abstractmethod|abc\.abstractmethod|override|typing\.override|functools\.cache|cache|lru_cache|functools\.lru_cache|cached_property|functools\.cached_property)$/;

/** 5. A call added in this change doesn't match the signature of what it calls. */
function newCallArityFindings(ctx: AnalysisContext): Finding[] {
  const out: Finding[] = [];
  const { changes, newIndex } = ctx;
  for (const fc of changes.files) {
    if (fc.status === 'deleted' || !ctx.reviewFiles.has(fc.path)) continue;
    const lang = langFor(fc.path)?.id;
    // Plain JavaScript allows any arity, so a mismatch is not proof of a bug there.
    if (!lang || lang === 'javascript' || lang === 'ruby') continue;
    const facts = newIndex.facts.get(fc.path);
    if (!facts || facts.syntaxErrors) continue;
    for (const call of facts.calls) {
      if (!fc.added.has(call.line) || call.spread) continue;
      const res = newIndex.resolveCall(fc.path, call).filter((r) => r.confidence >= 0.85 && r.def.kind !== 'class' && !newIndex.facts.get(r.file)?.syntaxErrors);
      if (!res.length) continue;
      if (res.some((r) => !r.def.params || (r.def.decorators ?? []).some((d) => !SAFE_DECORATORS.test(d)))) continue;
      // Any definition of this name that accepts the call means we can't be sure.
      const pool = OVERLOADING.has(lang) || call.qualifier ? newIndex.allDefs(call.name).map((d) => d.def) : res.map((r) => r.def);
      if (pool.some((d) => !d.params || arityMismatch(d.params, call) === null)) continue;
      const target = res[0];
      const m = arityMismatch(target.def.params, call)!;
      const what = m.kind === 'too-many' ? `passes ${m.got} argument${m.got === 1 ? '' : 's'}, but it accepts at most ${m.max}` : `is missing ${m.missing.map((x) => `\`${x}\``).join(', ')}`;
      out.push(
        finalize(
          {
            source: 'static',
            rule: 'contract/bad-arity',
            severity: 'P1',
            category: 'contract',
            file: fc.path,
            line: call.line,
            title: `This call to \`${call.name}()\` ${what}`,
            body: `\`${call.name}\` is defined at \`${target.file}:${target.def.line}\` as \`${target.def.signature}\`. ${STATIC_LANGS.has(lang) ? 'This will not compile.' : 'This raises a TypeError when it runs.'}`,
            evidence: [evidence(changes.newSnap, fc.path, call.line, 'call added in this change'), evidence(changes.newSnap, target.file, target.def.line, 'definition')],
            confidence: target.confidence,
            verification: 'deterministic',
          },
          changes.newSnap,
        ),
      );
    }
  }
  return out;
}

function danglingFinding(ctx: AnalysisContext, file: string, line: number, name: string, from: string, verb: 'imports' | 'calls'): Finding {
  const snap = ctx.changes.newSnap;
  const inDiff = ctx.changes.files.some((f) => f.path === file);
  return finalize(
    {
      source: 'static',
      rule: 'contract/dangling-reference',
      severity: 'P0',
      category: 'contract',
      file,
      line,
      title: `${verb === 'imports' ? 'Imports' : 'Calls'} \`${name}\`, which this change removed from \`${from}\``,
      body: `\`${name}\` no longer exists in \`${from}\`, but \`${file}\` still ${verb === 'imports' ? 'imports' : 'calls'} it${inDiff ? '' : ' (and this file is not part of the change)'}. This breaks at build time or on first use.`,
      evidence: [evidence(snap, file, line, `reference to removed \`${name}\``)],
      confidence: 0.95,
      verification: 'deterministic',
    },
    snap,
  );
}
