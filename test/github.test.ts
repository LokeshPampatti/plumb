import { createServer, type Server } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runGithub } from '../src/github.js';
import { tempRepo, type TempRepo } from './helpers.js';

interface Call {
  method: string;
  path: string;
  body: any;
}

/** A tiny in-memory GitHub REST + GraphQL fake. */
function fakeGithub(state: { pr: any; reviewComments: any[]; issueComments: any[]; threads: any[] }) {
  const calls: Call[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const path = (req.url ?? '').replace(/[?&]per_page=\d+&page=\d+$/, '');
      calls.push({ method: req.method!, path, body });
      const send = (code: number, data: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const page = Number((req.url ?? '').match(/[?&]page=(\d+)/)?.[1] ?? 1);
      if (req.method === 'GET' && /\/pulls\/\d+$/.test(path)) return send(200, state.pr);
      if (req.method === 'GET' && /\/pulls\/\d+\/reviews$/.test(path)) return send(200, []);
      if (req.method === 'GET' && /\/pulls\/\d+\/comments$/.test(path)) return send(200, page === 1 ? state.reviewComments : []);
      if (req.method === 'GET' && /\/issues\/\d+\/comments$/.test(path)) return send(200, page === 1 ? state.issueComments : []);
      if (req.method === 'POST' && /\/issues\/\d+\/comments$/.test(path)) {
        state.issueComments.push({ id: 900 + state.issueComments.length, body: body.body });
        return send(201, {});
      }
      if (req.method === 'PATCH' && /\/issues\/comments\/\d+$/.test(path)) return send(200, {});
      if (req.method === 'POST' && /\/pulls\/\d+\/reviews$/.test(path)) {
        for (const c of body.comments ?? []) {
          const id = 500 + state.reviewComments.length;
          state.reviewComments.push({ id, node_id: `N${id}`, body: c.body, path: c.path, line: c.line });
          state.threads.push({ id: `T${id}`, isResolved: false, comments: { nodes: [{ id: `N${id}`, databaseId: id }] } });
        }
        return send(200, {});
      }
      if (req.method === 'POST' && /\/comments\/\d+\/replies$/.test(path)) return send(201, {});
      if (req.method === 'POST' && path.endsWith('/graphql')) {
        if (body.query.startsWith('query')) return send(200, { data: { repository: { pullRequest: { reviewThreads: { nodes: state.threads } } } } });
        const t = state.threads.find((x) => x.id === body.variables.id);
        if (t) t.isResolved = true;
        return send(200, { data: { resolveReviewThread: { thread: { id: body.variables.id } } } });
      }
      send(404, { message: `unhandled ${req.method} ${path}` });
    });
  });
  return { server, calls };
}

let repo: TempRepo | null = null;
let server: Server | null = null;
afterEach(() => {
  repo?.cleanup();
  server?.close();
  repo = null;
  server = null;
});

describe('GitHub Action flow', () => {
  it('posts a summary + inline comments once, then resolves threads when fixed', async () => {
    repo = tempRepo();
    repo.write({
      'src/billing.ts': `export function charge(user: string, amount: number) {\n  return { user, amount };\n}\n`,
      'src/checkout.ts': `import { charge } from './billing';\nexport const go = (u: string) => charge(u, 1);\n`,
    });
    repo.commit('init');
    const base = repo.git('rev-parse', 'HEAD').trim();
    repo.git('checkout', '-q', '-b', 'feature');
    repo.write({ 'src/billing.ts': `export function charge(user: string, amount: number, key: string) {\n  return { user, amount, key };\n}\n` });
    repo.commit('add key');
    const head1 = repo.git('rev-parse', 'HEAD').trim();

    const state = {
      pr: { number: 7, title: 'Add idempotency key', body: '', draft: false, labels: [], user: { login: 'dev' }, base: { sha: base, ref: 'main' }, head: { sha: head1, ref: 'feature', repo: { full_name: 'acme/app' } } },
      reviewComments: [] as any[],
      issueComments: [] as any[],
      threads: [] as any[],
    };
    const gh = fakeGithub(state);
    server = gh.server;
    await new Promise<void>((r) => server!.listen(0, r));
    const port = (server.address() as any).port;

    const eventPath = join(repo.root, 'event.json');
    writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 7 } }));
    Object.assign(process.env, {
      GITHUB_API_URL: `http://127.0.0.1:${port}`,
      GITHUB_TOKEN: 't',
      GITHUB_REPOSITORY: 'acme/app',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: eventPath,
      PLUMB_PROVIDER: '',
      PLUMB_MODEL: '',
    });
    const cwd = process.cwd();
    process.chdir(repo.root);
    try {
      await runGithub();
      expect(state.issueComments).toHaveLength(1);
      expect(state.issueComments[0].body).toContain('<!-- plumb:summary -->');
      expect(state.reviewComments).toHaveLength(1);
      expect(state.reviewComments[0]).toMatchObject({ path: 'src/billing.ts', line: 1 });
      expect(state.reviewComments[0].body).toContain('now takes 3 arguments');

      // Second run on the same head: summary is edited, nothing new is posted.
      await runGithub();
      expect(state.issueComments).toHaveLength(1);
      expect(gh.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
      expect(state.reviewComments).toHaveLength(1);

      // Fix the caller: the thread gets a reply and is resolved.
      repo.write({ 'src/checkout.ts': `import { charge } from './billing';\nexport const go = (u: string) => charge(u, 1, 'k');\n` });
      repo.commit('fix caller');
      state.pr.head.sha = repo.git('rev-parse', 'HEAD').trim();
      await runGithub();
      expect(state.threads[0].isResolved).toBe(true);
      expect(gh.calls.some((c) => c.path.endsWith('/comments/500/replies') && /No longer reproduces/.test(c.body.body))).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });
});
