import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TempRepo {
  root: string;
  write(files: Record<string, string>): void;
  remove(path: string): void;
  commit(msg: string, opts?: { author?: string; email?: string }): void;
  git(...args: string[]): string;
  cleanup(): void;
}

export function tempRepo(): TempRepo {
  const root = mkdtempSync(join(tmpdir(), 'plumb-test-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'me@example.com');
  git('config', 'user.name', 'Me');
  git('config', 'commit.gpgsign', 'false');
  return {
    root,
    write(files) {
      for (const [p, c] of Object.entries(files)) {
        mkdirSync(dirname(join(root, p)), { recursive: true });
        writeFileSync(join(root, p), c);
      }
    },
    remove(p) {
      rmSync(join(root, p), { force: true });
    },
    commit(msg, opts = {}) {
      git('add', '-A');
      const env = { ...process.env };
      if (opts.author) {
        env.GIT_AUTHOR_NAME = opts.author;
        env.GIT_COMMITTER_NAME = opts.author;
      }
      if (opts.email) {
        env.GIT_AUTHOR_EMAIL = opts.email;
        env.GIT_COMMITTER_EMAIL = opts.email;
      }
      execFileSync('git', ['commit', '-q', '-m', msg], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    },
    git,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
