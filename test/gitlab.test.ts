import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { runGitlab } from '../src/gitlab.js';
import { tempRepo, type TempRepo } from './helpers.js';

let repo: TempRepo | null = null;
let server: Server | null = null;
afterEach(() => {
  repo?.cleanup();
  server?.close();
  repo = null;
  server = null;
});

describe('GitLab CI flow', () => {
  it('posts a summary note and discussions once, then resolves fixed ones', async () => {
    repo = tempRepo();
    repo.write({
      'src/billing.ts': `export function charge(user: string, amount: number) {\n  return { user, amount };\n}\n`,
      'src/checkout.ts': `import { charge } from './billing';\nexport const go = (u: string) => charge(u, 1);\n`,
    });
    repo.commit('init');
    const base = repo.git('rev-parse', 'HEAD').trim();
    repo.write({ 'src/billing.ts': `export function charge(user: string, amount: number, key: string) {\n  return { user, amount, key };\n}\n` });
    repo.commit('add key');

    const state = {
      head: repo.git('rev-parse', 'HEAD').trim(),
      notes: [] as any[],
      discussions: [] as any[],
      calls: [] as { method: string; path: string; body: any }[],
    };
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : undefined;
        const url = new URL(req.url ?? '', 'http://x');
        const path = url.pathname.replace('/api/v4/projects/42/merge_requests/7', '');
        const page = Number(url.searchParams.get('page') ?? 1);
        state.calls.push({ method: req.method!, path, body });
        const send = (code: number, data: unknown) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(data));
        };
        if (req.method === 'GET' && path === '') return send(200, { title: 'Add key', description: '', draft: false, labels: [], sha: state.head, web_url: 'https://gitlab.example/acme/app/-/merge_requests/7' });
        if (req.method === 'GET' && path === '/versions') return send(200, [{ base_commit_sha: base, start_commit_sha: base, head_commit_sha: state.head }]);
        if (req.method === 'GET' && path === '/notes') return send(200, page === 1 ? state.notes : []);
        if (req.method === 'POST' && path === '/notes') {
          state.notes.push({ id: state.notes.length + 1, body: body.body });
          return send(201, {});
        }
        if (req.method === 'PUT' && /^\/notes\/\d+$/.test(path)) return send(200, {});
        if (req.method === 'GET' && path === '/discussions') return send(200, page === 1 ? state.discussions : []);
        if (req.method === 'POST' && path === '/discussions') {
          state.discussions.push({ id: `d${state.discussions.length + 1}`, notes: [{ body: body.body, resolved: false, position: body.position }] });
          return send(201, {});
        }
        if (req.method === 'POST' && /^\/discussions\/d\d+\/notes$/.test(path)) return send(201, {});
        if (req.method === 'PUT' && /^\/discussions\/d\d+$/.test(path)) {
          const d = state.discussions.find((x) => path.endsWith(x.id));
          if (d && url.searchParams.get('resolved') === 'true') d.notes[0].resolved = true;
          return send(200, {});
        }
        send(404, { message: `unhandled ${req.method} ${path}` });
      });
    });
    await new Promise<void>((r) => server!.listen(0, r));
    const port = (server.address() as any).port;
    Object.assign(process.env, { CI_API_V4_URL: `http://127.0.0.1:${port}/api/v4`, GITLAB_TOKEN: 't', CI_PROJECT_ID: '42', CI_MERGE_REQUEST_IID: '7', PLUMB_PROVIDER: '', PLUMB_MODEL: '' });
    const cwd = process.cwd();
    process.chdir(repo.root);
    try {
      await runGitlab();
      expect(state.notes).toHaveLength(1);
      expect(state.notes[0].body).toContain('<!-- plumb:summary -->');
      expect(state.discussions).toHaveLength(1);
      expect(state.discussions[0].notes[0].position).toMatchObject({ new_path: 'src/billing.ts', new_line: 1, head_sha: state.head });

      await runGitlab();
      expect(state.notes).toHaveLength(1);
      expect(state.discussions).toHaveLength(1);

      repo.write({ 'src/checkout.ts': `import { charge } from './billing';\nexport const go = (u: string) => charge(u, 1, 'k');\n` });
      repo.commit('fix caller');
      state.head = repo.git('rev-parse', 'HEAD').trim();
      await runGitlab();
      expect(state.discussions[0].notes[0].resolved).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });
});
