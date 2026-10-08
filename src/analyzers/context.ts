import { createHash } from 'node:crypto';
import type { LoadedConfig } from '../config.js';
import type { ChangeSet, Snapshot } from '../git.js';
import type { RepoIndex } from '../index/graph.js';
import type { Evidence, Finding } from '../types.js';
import { redactSecrets } from '../redact.js';

export interface AnalysisContext {
  changes: ChangeSet;
  newIndex: RepoIndex;
  /** Only the changed files, parsed at the base revision. */
  oldIndex: RepoIndex;
  loaded: LoadedConfig;
  /** Files the review covers (changed, not ignored). */
  reviewFiles: Set<string>;
}

export function lineText(snap: Snapshot, file: string, line: number): string {
  const src = snap.read(file);
  if (!src) return '';
  return src.split('\n')[line - 1] ?? '';
}

export function evidence(snap: Snapshot, file: string, line: number, note: string): Evidence {
  return { file, line, snippet: redactSecrets(lineText(snap, file, line)).trim().slice(0, 240), note };
}

/**
 * A fingerprint that survives unrelated edits: rule + file + the trimmed text of
 * the flagged line + a normalized title. Line numbers are deliberately left out.
 */
export function fingerprint(rule: string, file: string, lineText: string, title: string): string {
  const norm = title
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/[^a-z0-9_#` ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12)
    .join(' ');
  return createHash('sha1').update(`${rule}\0${file}\0${lineText.trim()}\0${norm}`).digest('hex').slice(0, 12);
}

export function finalize(f: Omit<Finding, 'id'>, snap: Snapshot): Finding {
  return { ...f, id: fingerprint(f.rule, f.file, lineText(snap, f.file, f.line), f.title) };
}
