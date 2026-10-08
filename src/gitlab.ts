// GitLab CI entry point: the same flow as the GitHub Action. One summary note
// edited in place, inline discussions for new findings only, discussions resolved
// when their finding no longer reproduces, and an explained approval.

import { execFileSync } from 'node:child_process';
import type { PlumbConfig } from './config.js';
import { commentableLines } from './diff.js';
import { collectChanges } from './git.js';
import { inlineComment, renderMarkdown, SUMMARY_MARKER } from './output/markdown.js';
import { runReview } from './review/pipeline.js';

const FINDING_RE = /<!-- plumb:finding=([0-9a-f]{12}) -->/;

function api(): string {
  return (process.env.CI_API_V4_URL ?? `${process.env.CI_SERVER_URL ?? 'https://gitlab.com'}/api/v4`).replace(/\/$/, '');
}

async function gl<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = process.env.GITLAB_TOKEN ?? process.env.PLUMB_GITLAB_TOKEN;
  if (!token) throw new Error('Set GITLAB_TOKEN (a project access token with the api scope) in CI variables.');
  const res = await fetch(api() + path, {
    method: init.method ?? 'GET',
    headers: { 'private-token': token, 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) throw new Error(`GitLab ${init.method ?? 'GET'} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (res.status === 204 ? null : await res.json()) as T;
}

async function all<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page < 30; page++) {
    const batch = await gl<T[]>(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

export async function runGitlab(): Promise<void> {
  const project = encodeURIComponent(process.env.CI_PROJECT_ID ?? '');
  const iid = process.env.CI_MERGE_REQUEST_IID;
  if (!project || !iid) {
    console.log('Not a merge request pipeline (CI_MERGE_REQUEST_IID is unset). Use `rules: - if: $CI_PIPELINE_SOURCE == "merge_request_event"`.');
    return;
  }
  const mrPath = `/projects/${project}/merge_requests/${iid}`;
  const mr = await gl(mrPath);
  if (mr.draft || mr.work_in_progress) {
    console.log('Draft merge request: skipping.');
    return;
  }
  const versions = await gl<any[]>(`${mrPath}/versions`);
  const v = versions[0];
  const base: string = v?.base_commit_sha ?? process.env.CI_MERGE_REQUEST_DIFF_BASE_SHA;
  const head: string = v?.head_commit_sha ?? mr.sha;
  const cwd = process.cwd();
  try {
    execFileSync('git', ['fetch', '--no-tags', 'origin', base, head], { cwd, stdio: 'ignore' });
  } catch {
    // commits may already be present
  }

  const env = process.env;
  const config: Partial<PlumbConfig> = {};
  if (env.PLUMB_PROVIDER || env.PLUMB_MODEL) {
    config.model = { provider: (env.PLUMB_PROVIDER || 'anthropic') as PlumbConfig['model']['provider'], name: env.PLUMB_MODEL || undefined, effort: (env.PLUMB_EFFORT as PlumbConfig['model']['effort']) || 'high' };
  }
  if (env.PLUMB_BUDGET_USD) config.budgetUsd = Number(env.PLUMB_BUDGET_USD);

  const result = await runReview({
    cwd,
    config,
    mode: { kind: 'range', from: base, to: head },
    prDescription: `${mr.title}\n\n${mr.description ?? ''}`,
    confirmSpend: async () => true, // budgetUsd is the consent in CI
    log: (m) => console.log(m),
    saveState: false,
    gateContext: { draft: !!mr.draft, labels: mr.labels ?? [] },
  });

  const changes = collectChanges(cwd, { kind: 'range', from: base, to: head });
  const visible = new Map(changes.files.map((f) => [f.path, commentableLines(f)]));
  const inlineable = result.findings.filter((f) => visible.get(f.file)?.has(f.line));
  const webUrl = `${mr.web_url.replace(/\/-\/merge_requests\/\d+$/, '')}/-/blob/${head}`;

  // Summary note, edited in place.
  const notes = await all<any>(`${mrPath}/notes?sort=asc`);
  const body = renderMarkdown(result, { inlineIds: new Set(inlineable.map((f) => f.id)), repoUrl: webUrl });
  const summary = notes.find((n) => n.body?.includes(SUMMARY_MARKER));
  if (summary) await gl(`${mrPath}/notes/${summary.id}`, { method: 'PUT', body: { body } });
  else await gl(`${mrPath}/notes`, { method: 'POST', body: { body } });

  // Inline discussions for findings not posted yet.
  const discussions = await all<any>(`${mrPath}/discussions`);
  const posted = new Map<string, any>();
  for (const d of discussions) {
    const m = d.notes?.[0]?.body?.match(FINDING_RE);
    if (m) posted.set(m[1], d);
  }
  let created = 0;
  for (const f of inlineable.slice(0, 40)) {
    if (posted.has(f.id)) continue;
    await gl(`${mrPath}/discussions`, {
      method: 'POST',
      body: {
        body: inlineComment(f, webUrl),
        position: { position_type: 'text', base_sha: v?.base_commit_sha ?? base, start_sha: v?.start_commit_sha ?? base, head_sha: head, new_path: f.file, old_path: f.file, new_line: f.line },
      },
    });
    created++;
  }

  // Resolve discussions whose finding no longer reproduces.
  const now = new Set(result.findings.map((f) => f.id));
  let resolved = 0;
  for (const [id, d] of posted) {
    if (now.has(id) || d.notes?.[0]?.resolved) continue;
    await gl(`${mrPath}/discussions/${d.id}/notes`, { method: 'POST', body: { body: `✅ No longer reproduces at ${head.slice(0, 8)}.` } });
    await gl(`${mrPath}/discussions/${d.id}?resolved=true`, { method: 'PUT' });
    resolved++;
  }

  if (result.gate.approve) {
    try {
      await gl(`${mrPath}/approve`, { method: 'POST', body: { sha: head } });
    } catch (e) {
      console.log(`Could not approve: ${(e as Error).message}`);
    }
  }
  console.log(`Score ${result.score.score}/5 · ${result.findings.length} findings (${created} new inline) · ${resolved} resolved · ${result.gate.reasons[0]}`);
  const failOn = process.env.PLUMB_FAIL_ON;
  if (failOn && failOn !== 'none') {
    const rank: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
    if (result.findings.some((f) => rank[f.severity] <= rank[failOn])) process.exitCode = 1;
  }
}
