import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { addedFileChange, parseUnifiedDiff } from './diff.js';
import type { FileChange } from './types.js';

const MAX_BUFFER = 256 * 1024 * 1024;

export function git(cwd: string, args: string[], opts: { allowFail?: boolean; input?: string } = {}): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      stdio: ['pipe', 'pipe', 'pipe'],
      input: opts.input,
    });
  } catch (err) {
    if (opts.allowFail) return '';
    const e = err as { stderr?: string; message: string };
    throw new Error(`git ${args.join(' ')} failed: ${(e.stderr || e.message).trim()}`);
  }
}

export function repoRoot(cwd: string): string {
  return git(cwd, ['rev-parse', '--show-toplevel']).trim();
}

export function hasCommits(root: string): boolean {
  return git(root, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true }).trim() !== '';
}

export function defaultBranch(root: string): string {
  const sym = git(root, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], { allowFail: true }).trim();
  if (sym) return sym.replace('refs/remotes/', '');
  for (const b of ['main', 'master', 'origin/main', 'origin/master', 'develop']) {
    if (git(root, ['rev-parse', '--verify', '-q', b], { allowFail: true }).trim()) return b;
  }
  return 'HEAD';
}

export function currentBranch(root: string): string {
  return git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }).trim() || 'HEAD';
}

export function headSha(root: string): string {
  return git(root, ['rev-parse', 'HEAD'], { allowFail: true }).trim();
}

export function userEmail(root: string): string {
  return git(root, ['config', 'user.email'], { allowFail: true }).trim();
}

/**
 * A read-only view of the code on one side of a change.
 * ref === null: the working tree (including uncommitted edits)
 * ref === ':'  : the index (staged content)
 * otherwise    : a commit-ish
 */
export class Snapshot {
  private cache = new Map<string, string | null>();
  private fileList: string[] | null = null;
  private fileSet: Set<string> | null = null;
  constructor(
    readonly root: string,
    readonly ref: string | null,
  ) {}

  private spec(path: string): string {
    return this.ref === ':' ? `:${path}` : `${this.ref}:${path}`;
  }

  read(path: string): string | null {
    if (this.cache.has(path)) return this.cache.get(path)!;
    let content: string | null = null;
    if (this.ref === null) {
      const abs = join(this.root, path);
      try {
        if (existsSync(abs) && statSync(abs).isFile()) content = readFileSync(abs, 'utf8');
      } catch {
        content = null;
      }
    } else if (this.exists(path)) {
      content = this.readMany([path]).get(path) ?? null;
    }
    this.cache.set(path, content);
    return content;
  }

  /** Read many files at once (one `git cat-file --batch` process per 2,000 files). */
  readMany(paths: string[]): Map<string, string | null> {
    const result = new Map<string, string | null>();
    const todo: string[] = [];
    for (const p of paths) {
      if (this.cache.has(p)) result.set(p, this.cache.get(p)!);
      else todo.push(p);
    }
    if (this.ref === null) {
      for (const p of todo) result.set(p, this.read(p));
      return result;
    }
    for (let i = 0; i < todo.length; i += 2000) {
      const chunk = todo.slice(i, i + 2000).filter((p) => !p.includes('\n'));
      if (!chunk.length) continue;
      let out: Buffer;
      try {
        out = execFileSync('git', ['cat-file', '--batch'], {
          cwd: this.root,
          input: chunk.map((p) => this.spec(p)).join('\n') + '\n',
          maxBuffer: 2 * 1024 * 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        for (const p of chunk) result.set(p, null);
        continue;
      }
      let pos = 0;
      for (const p of chunk) {
        const nl = out.indexOf(10, pos);
        if (nl < 0) break;
        const header = out.subarray(pos, nl).toString('utf8');
        if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
          result.set(p, null);
          this.cache.set(p, null);
          pos = nl + 1;
          continue;
        }
        const size = Number(header.split(' ')[2]);
        const body = out.subarray(nl + 1, nl + 1 + size);
        const text = body.includes(0) ? null : body.toString('utf8');
        result.set(p, text);
        this.cache.set(p, text);
        pos = nl + 1 + size + 1;
      }
    }
    return result;
  }

  exists(path: string): boolean {
    if (!this.fileSet) this.fileSet = new Set(this.files());
    return this.fileSet.has(path);
  }

  files(): string[] {
    if (this.fileList) return this.fileList;
    let out: string;
    if (this.ref === null) out = git(this.root, ['ls-files', '-co', '--exclude-standard', '-z']);
    else if (this.ref === ':') out = git(this.root, ['ls-files', '-z']);
    else out = git(this.root, ['ls-tree', '-r', '--name-only', '-z', this.ref]);
    this.fileList = out.split('\0').filter(Boolean);
    if (this.ref === null) this.fileList = this.fileList.filter((f) => existsSync(join(this.root, f)));
    return this.fileList;
  }
}

export type DiffMode =
  | { kind: 'working' } // everything not yet committed, vs HEAD (incl. untracked)
  | { kind: 'staged' }
  | { kind: 'branch'; base?: string; includeUncommitted?: boolean }
  | { kind: 'range'; from: string; to: string; /** `to` is checked out and clean: read it from disk (fast in partial clones). */ worktreeIsHead?: boolean };

export interface ChangeSet {
  root: string;
  mode: DiffMode;
  baseRef: string; // a commit-ish for the "old" side
  headRef: string | null; // null = working tree, ':' = index
  files: FileChange[];
  label: string;
  oldSnap: Snapshot;
  newSnap: Snapshot;
  /** The files on disk are exactly the reviewed revision, so tools that read the disk see the right code. */
  worktreeIsHead: boolean;
}

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '-M', '--unified=3'];

export function collectChanges(cwd: string, mode: DiffMode): ChangeSet {
  const root = repoRoot(cwd);
  const committed = hasCommits(root);
  let baseRef: string;
  let headRef: string | null;
  let diffText: string;
  let label: string;
  let untracked: string[] = [];

  // In an empty repo there is nothing to diff against: treat every file as added.
  const EMPTY_TREE = git(root, ['hash-object', '-t', 'tree', '/dev/null'], { allowFail: true }).trim() || '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

  switch (mode.kind) {
    case 'working': {
      baseRef = committed ? 'HEAD' : EMPTY_TREE;
      headRef = null;
      diffText = committed ? git(root, ['diff', ...DIFF_FLAGS, 'HEAD']) : git(root, ['diff', ...DIFF_FLAGS, '--cached', EMPTY_TREE]);
      untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
      label = 'uncommitted changes';
      break;
    }
    case 'staged': {
      baseRef = committed ? 'HEAD' : EMPTY_TREE;
      headRef = ':'; // staged reviews read the index, not the working tree
      diffText = git(root, ['diff', ...DIFF_FLAGS, '--cached', ...(committed ? [] : [EMPTY_TREE])]);
      label = 'staged changes';
      break;
    }
    case 'branch': {
      const base = mode.base ?? defaultBranch(root);
      const mb = git(root, ['merge-base', base, 'HEAD'], { allowFail: true }).trim();
      if (!mb) throw new Error(`No common ancestor between ${base} and HEAD. Pass --base <branch>.`);
      baseRef = mb;
      if (mode.includeUncommitted) {
        headRef = null;
        diffText = git(root, ['diff', ...DIFF_FLAGS, mb]);
        untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
      } else {
        headRef = 'HEAD';
        diffText = git(root, ['diff', ...DIFF_FLAGS, mb, 'HEAD']);
      }
      label = `${currentBranch(root)} vs ${base}`;
      break;
    }
    case 'range': {
      baseRef = mode.from;
      headRef = mode.worktreeIsHead ? null : mode.to;
      diffText = git(root, ['diff', ...DIFF_FLAGS, mode.from, mode.to]);
      label = `${mode.from}..${mode.to}`;
      break;
    }
  }

  const files = parseUnifiedDiff(diffText);
  const newSnap = new Snapshot(root, headRef);
  let worktreeIsHead = headRef === null;
  if (headRef && headRef !== ':') {
    const resolved = git(root, ['rev-parse', '--verify', '-q', `${headRef}^{commit}`], { allowFail: true }).trim();
    const dirty = git(root, ['status', '--porcelain', '--untracked-files=no'], { allowFail: true }).trim();
    worktreeIsHead = !!resolved && resolved === headSha(root) && dirty === '';
  }
  for (const u of untracked) {
    if (files.some((f) => f.path === u)) continue;
    const content = newSnap.read(u);
    if (content === null || content.includes('\0')) continue;
    files.push(addedFileChange(u, content));
  }
  return { root, mode, baseRef, headRef, files, label, oldSnap: new Snapshot(root, baseRef), newSnap, worktreeIsHead };
}

export interface CommitInfo {
  sha: string;
  author: string;
  email: string;
  time: number;
  subject: string;
  files: string[];
}

/** Recent history for a set of paths, newest first. */
export function history(root: string, paths: string[], opts: { maxCount?: number; sinceDays?: number } = {}): CommitInfo[] {
  if (!hasCommits(root) || paths.length === 0) return [];
  const args = ['log', '--no-merges', '--format=%x1e%H%x1f%an%x1f%ae%x1f%at%x1f%s', '--name-only', `-n${opts.maxCount ?? 400}`];
  if (opts.sinceDays) args.push(`--since=${opts.sinceDays}.days`);
  args.push('--', ...paths);
  const out = git(root, args, { allowFail: true });
  const commits: CommitInfo[] = [];
  for (const rec of out.split('\x1e')) {
    if (!rec.trim()) continue;
    const [head, ...rest] = rec.split('\n');
    const [sha, author, email, time, subject] = head.split('\x1f');
    commits.push({ sha, author, email, time: Number(time), subject: subject ?? '', files: rest.map((s) => s.trim()).filter(Boolean) });
  }
  return commits;
}
