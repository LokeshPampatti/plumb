// Review any GitHub pull request without cloning it yourself. Plumb fetches only
// the merge-base and head commits (blobs on demand) into a cache directory.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DiffMode } from './git.js';

export interface PrSpec {
  owner: string;
  repo: string;
  number: number;
}

export function parsePrSpec(s: string): PrSpec | null {
  const url = s.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/);
  if (url) return { owner: url[1], repo: url[2].replace(/\.git$/, ''), number: Number(url[3]) };
  const short = s.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (short) return { owner: short[1], repo: short[2], number: Number(short[3]) };
  return null;
}

async function gh<T>(path: string): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`, { headers });
  if (res.status === 403 || res.status === 429) throw new Error('GitHub rate limit hit. Set GITHUB_TOKEN to raise it.');
  if (res.status === 404) throw new Error('Pull request not found. For a private repo, set GITHUB_TOKEN.');
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}`);
  return (await res.json()) as T;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
}

function have(cwd: string, sha: string): boolean {
  try {
    git(cwd, 'cat-file', '-e', `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

export interface PreparedPr {
  cwd: string;
  mode: DiffMode;
  title: string;
  body: string;
  url: string;
  headSha: string;
  baseRef: string;
}

/** Fetch a PR into ~/.cache/plumb/repos and check out its head, ready for runReview. */
export async function preparePr(spec: PrSpec, log: (m: string) => void = () => {}): Promise<PreparedPr> {
  const pr = await gh<{ title: string; body: string | null; html_url: string; head: { sha: string }; base: { sha: string; ref: string; repo: { clone_url: string } } }>(
    `/repos/${spec.owner}/${spec.repo}/pulls/${spec.number}`,
  );
  const cmp = await gh<{ merge_base_commit: { sha: string } }>(`/repos/${spec.owner}/${spec.repo}/compare/${pr.base.sha}...${pr.head.sha}`);
  const mergeBase = cmp.merge_base_commit.sha;

  const dir = join(process.env.PLUMB_CACHE ?? join(homedir(), '.cache', 'plumb'), 'repos', spec.owner, spec.repo);
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    git(dir, 'remote', 'add', 'origin', pr.base.repo.clone_url);
  }
  for (const [sha, ref] of [
    [mergeBase, null],
    [pr.head.sha, `pull/${spec.number}/head`],
  ] as const) {
    if (have(dir, sha)) continue;
    log(`Fetching ${sha.slice(0, 9)}...`);
    try {
      git(dir, 'fetch', '-q', '--depth=1', '--filter=blob:none', 'origin', sha);
    } catch {
      // Some hosts refuse fetch-by-sha; the PR ref always works for the head.
      if (ref) git(dir, 'fetch', '-q', '--depth=1', '--filter=blob:none', 'origin', ref);
      else throw new Error(`Could not fetch merge-base ${sha}`);
    }
  }
  log('Checking out the PR head...');
  git(dir, 'checkout', '-q', '-f', '--detach', pr.head.sha);
  git(dir, 'clean', '-qfdx', '-e', '.plumb');

  return {
    cwd: dir,
    mode: { kind: 'range', from: mergeBase, to: pr.head.sha, worktreeIsHead: true },
    title: pr.title,
    body: pr.body ?? '',
    url: pr.html_url,
    headSha: pr.head.sha,
    baseRef: pr.base.ref,
  };
}
