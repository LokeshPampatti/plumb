// GitHub Actions entry point. Reviews the PR, keeps one summary comment up to
// date, posts inline comments only for new findings, resolves threads whose
// finding is gone, explains every auto-approve decision, and turns
// "/plumb dismiss <reason>" replies into a commit to .plumb/memory.json on the
// PR branch, so what the bot learns is reviewed like any other code.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { commentableLines } from './diff.js';
import { collectChanges, repoRoot } from './git.js';
import { learnFromDismissal, loadMemory, saveMemory } from './memory.js';
import { inlineComment, renderMarkdown, SUMMARY_MARKER } from './output/markdown.js';
import { runReview } from './review/pipeline.js';
import type { Finding } from './types.js';
import type { PlumbConfig } from './config.js';

const api = () => (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');

async function gh<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set');
  const res = await fetch(path.startsWith('http') ? path : api() + path, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (res.status === 204 ? null : await res.json()) as T;
}

async function paginate<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page < 20; page++) {
    const batch = await gh<T[]>(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

const FINDING_RE = /<!-- plumb:finding=([0-9a-f]{12}) -->/;
const META_RE = /<!-- plumb:meta=(\{.*?\}) -->/;

export async function runGithub(): Promise<void> {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8'));
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');
  const name = process.env.GITHUB_EVENT_NAME;

  if (name === 'pull_request_review_comment' && /^\s*\/plumb\s+dismiss\b/i.test(event.comment?.body ?? '')) {
    return handleDismiss(owner, repo, event);
  }
  if (name === 'issue_comment' && !(event.issue?.pull_request && /(^|\s)(@plumb|\/plumb)\s+review\b/i.test(event.comment?.body ?? ''))) return;

  const number: number = event.pull_request?.number ?? event.issue?.number;
  const pr = await gh(`/repos/${owner}/${repo}/pulls/${number}`);
  if (pr.draft && name !== 'issue_comment') {
    console.log('Draft PR: skipping (comment "/plumb review" to review a draft).');
    return;
  }
  const excluded = (process.env.PLUMB_EXCLUDE_AUTHORS ?? 'dependabot[bot],renovate[bot]').split(',').map((s) => s.trim());
  if (excluded.includes(pr.user?.login)) {
    console.log(`Author ${pr.user.login} is excluded.`);
    return;
  }

  const cwd = process.cwd();
  try {
    execFileSync('git', ['fetch', '--no-tags', 'origin', pr.base.sha, pr.head.sha], { cwd, stdio: 'ignore' });
  } catch {
    // Shallow or already-present checkouts: the commits may be local already.
  }
  const reviews = await paginate<any>(`/repos/${owner}/${repo}/pulls/${number}/reviews`);
  const changesRequested = reviews.some((r) => r.state === 'CHANGES_REQUESTED' && r.user?.type !== 'Bot');

  // Action inputs arrive as env vars and override .plumb/config.json.
  const env = process.env;
  const config: Partial<PlumbConfig> = {};
  if (env.PLUMB_PROVIDER || env.PLUMB_MODEL) {
    config.model = { provider: (env.PLUMB_PROVIDER || 'anthropic') as PlumbConfig['model']['provider'], name: env.PLUMB_MODEL || undefined, effort: (env.PLUMB_EFFORT as PlumbConfig['model']['effort']) || 'high' };
  }
  if (env.PLUMB_BUDGET_USD) config.budgetUsd = Number(env.PLUMB_BUDGET_USD);

  const result = await runReview({
    cwd,
    config,
    mode: { kind: 'range', from: pr.base.sha, to: pr.head.sha },
    prDescription: `${pr.title}\n\n${pr.body ?? ''}`,
    instructions: name === 'issue_comment' ? event.comment.body.replace(/(@plumb|\/plumb)\s+review\b/i, '').trim() || undefined : undefined,
    confirmSpend: async () => true, // budgetUsd in .plumb/config.json is the consent in CI
    log: (m) => console.log(m),
    saveState: false,
    gateContext: { draft: pr.draft, changesRequested, labels: (pr.labels ?? []).map((l: any) => l.name) },
  });

  // Which findings can be shown inline (GitHub only allows lines in the diff)?
  const changes = collectChanges(cwd, { kind: 'range', from: pr.base.sha, to: pr.head.sha });
  const visible = new Map(changes.files.map((f) => [f.path, commentableLines(f)]));
  const inlineable = result.findings.filter((f) => visible.get(f.file)?.has(f.line));

  const existing = await paginate<any>(`/repos/${owner}/${repo}/pulls/${number}/comments`);
  const posted = new Map<string, any>();
  for (const c of existing) {
    const m = c.body?.match(FINDING_RE);
    if (m && !c.in_reply_to_id) posted.set(m[1], c);
  }
  const nowIds = new Set(result.findings.map((f) => f.id));
  const fresh = inlineable.filter((f) => !posted.has(f.id));

  const repoUrl = `https://github.com/${owner}/${repo}/blob/${pr.head.sha}`;
  const body = renderMarkdown(result, { inlineIds: new Set(inlineable.map((f) => f.id)), repoUrl });

  // Summary: one comment, edited in place.
  const issueComments = await paginate<any>(`/repos/${owner}/${repo}/issues/${number}/comments`);
  const summary = issueComments.find((c) => c.body?.includes(SUMMARY_MARKER));
  if (summary) await gh(`/repos/${owner}/${repo}/issues/comments/${summary.id}`, { method: 'PATCH', body: { body } });
  else await gh(`/repos/${owner}/${repo}/issues/${number}/comments`, { method: 'POST', body: { body } });

  // Inline comments for new findings, plus the merge-gate decision.
  const withMeta = (f: Finding) => inlineComment(f, repoUrl) + `\n<!-- plumb:meta=${JSON.stringify({ id: f.id, rule: f.rule, category: f.category, severity: f.severity, file: f.file, title: f.title.slice(0, 120) })} -->`;
  if (fresh.length || result.gate.approve) {
    await gh(`/repos/${owner}/${repo}/pulls/${number}/reviews`, {
      method: 'POST',
      body: {
        commit_id: pr.head.sha,
        event: result.gate.approve ? 'APPROVE' : 'COMMENT',
        body: result.gate.approve ? result.gate.reasons.join('\n') : `Plumb found ${fresh.length} new issue${fresh.length === 1 ? '' : 's'}. Full report in the summary comment.`,
        comments: fresh.slice(0, 40).map((f) => ({
          path: f.file,
          line: f.endLine && visible.get(f.file)?.has(f.endLine) ? f.endLine : f.line,
          ...(f.endLine && f.endLine > f.line && visible.get(f.file)?.has(f.endLine) ? { start_line: f.line } : {}),
          side: 'RIGHT',
          body: withMeta(f),
        })),
      },
    });
  }

  // Resolve threads whose finding no longer reproduces.
  const gone = [...posted.entries()].filter(([id]) => !nowIds.has(id));
  if (gone.length) await resolveThreads(owner, repo, number, new Set(gone.map(([, c]) => c.node_id)), pr.head.sha);

  console.log(`Score ${result.score.score}/5 · ${result.findings.length} findings (${fresh.length} new inline) · ${gone.length} resolved · ${result.gate.reasons[0]}`);
  const failOn = process.env.PLUMB_FAIL_ON;
  if (failOn && failOn !== 'none') {
    const rank: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
    if (result.findings.some((f) => rank[f.severity] <= rank[failOn])) process.exitCode = 1;
  }
}

async function graphql<T = any>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await gh<{ data: T; errors?: { message: string }[] }>(`${api()}/graphql`, { method: 'POST', body: { query, variables } });
  if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '));
  return res.data;
}

async function resolveThreads(owner: string, repo: string, number: number, commentNodeIds: Set<string>, sha: string): Promise<void> {
  const data = await graphql<any>(
    `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$n){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{id databaseId}}}}}}}`,
    { owner, repo, n: number },
  );
  for (const t of data.repository.pullRequest.reviewThreads.nodes) {
    const first = t.comments.nodes[0];
    if (!first || t.isResolved || !commentNodeIds.has(first.id)) continue;
    await gh(`/repos/${owner}/${repo}/pulls/${number}/comments/${first.databaseId}/replies`, { method: 'POST', body: { body: `✅ No longer reproduces at ${sha.slice(0, 7)}.` } });
    await graphql(`mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}`, { id: t.id });
  }
}

async function handleDismiss(owner: string, repo: string, event: any): Promise<void> {
  const number = event.pull_request.number;
  const parentId = event.comment.in_reply_to_id;
  const reply = (body: string) => gh(`/repos/${owner}/${repo}/pulls/${number}/comments/${parentId}/replies`, { method: 'POST', body: { body } });
  if (!parentId) return;
  const parent = await gh(`/repos/${owner}/${repo}/pulls/comments/${parentId}`);
  const meta = parent.body?.match(META_RE);
  if (!meta) return;
  const m = JSON.parse(meta[1]);
  const finding: Finding = {
    id: m.id,
    source: 'llm',
    rule: m.rule,
    severity: m.severity,
    category: m.category,
    file: m.file,
    line: 0,
    title: m.title,
    body: '',
    evidence: [],
    confidence: 0,
    verification: 'confirmed',
  };
  const reason = event.comment.body.replace(/^\s*\/plumb\s+dismiss\s*/i, '').trim() || undefined;
  const who = event.comment.user?.login;
  const root = repoRoot(process.cwd());
  const pr = event.pull_request;

  // Dry run first, so we can refuse protected findings without touching git.
  const probe = learnFromDismissal(loadMemory(root, ''), finding, { reason, who });
  if (probe.refused) {
    await reply(`I can't learn to ignore this one: ${probe.refused}`);
    return;
  }
  if (pr.head.repo?.full_name !== `${owner}/${repo}`) {
    await reply(`Noted. This PR comes from a fork, so I can't commit to it. Run \`plumb dismiss ${m.id}${reason ? ` -r "${reason}"` : ''}\` locally to save the rule.`);
    return;
  }
  try {
    const git = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
    git('config', 'user.name', 'plumb[bot]');
    git('config', 'user.email', 'plumb-bot@users.noreply.github.com');
    git('fetch', 'origin', pr.head.ref);
    git('checkout', '-f', '-B', pr.head.ref, `origin/${pr.head.ref}`);
    // Learn on top of the branch's current memory so nothing else is lost.
    const mem = loadMemory(root);
    const res = learnFromDismissal(mem, finding, { reason, who });
    saveMemory(root, mem);
    git('add', '.plumb/memory.json');
    git('commit', '-m', `plumb: learn from @${who}'s dismissal\n\n${res.rule.text}`);
    git('push', 'origin', `HEAD:${pr.head.ref}`);
    await reply(`Learned rule \`${res.rule.id}\`: ${res.rule.text}\n\nCommitted to \`.plumb/memory.json\` on this branch, so the team can see and review it. It applies to reviews once this PR merges.`);
  } catch (e) {
    await reply(`I understood the dismissal but couldn't push the rule (${(e as Error).message.slice(0, 120)}). Run \`plumb dismiss ${m.id}\` locally.`);
  }
}
