// Learn team preferences from the human review comments already in a repo's PR
// history. Every proposed rule cites the comments it came from, and nothing is
// saved until the user accepts it.

import type { Provider } from './llm/provider.js';
import { redactBlock } from './redact.js';

export interface ReviewComment {
  id: number;
  url: string;
  author: string;
  path: string;
  body: string;
  pr: number;
}

export interface ProposedRule {
  text: string;
  /** Glob the rule applies to, or empty for the whole repo. */
  paths?: string[];
  evidence: ReviewComment[];
}

async function gh<T>(path: string): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`, { headers });
  if (res.status === 403 || res.status === 429) throw new Error('GitHub rate limit hit. Set GITHUB_TOKEN to raise it.');
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}`);
  return (await res.json()) as T;
}

const NOISE = /^(lgtm|thanks|thank you|nit:?\s*$|done|fixed|good catch|\+1|👍|ack|ok|sgtm|resolved)\W*$/i;

/** Recent human inline review comments, newest first. Bots and acknowledgements are dropped. */
export async function fetchReviewComments(owner: string, repo: string, max = 300): Promise<ReviewComment[]> {
  const out: ReviewComment[] = [];
  for (let page = 1; out.length < max && page <= 10; page++) {
    const batch = await gh<any[]>(`/repos/${owner}/${repo}/pulls/comments?sort=created&direction=desc&per_page=100&page=${page}`);
    for (const c of batch) {
      const body = String(c.body ?? '').trim();
      if (c.user?.type === 'Bot' || /\[bot\]$/.test(c.user?.login ?? '')) continue;
      if (c.in_reply_to_id && body.length < 40) continue;
      if (body.length < 25 || NOISE.test(body) || /<!-- plumb:/.test(body)) continue;
      out.push({ id: c.id, url: c.html_url, author: c.user?.login ?? '?', path: c.path ?? '', body: body.slice(0, 600), pr: Number(String(c.pull_request_url ?? '').split('/').pop()) });
    }
    if (batch.length < 100) break;
  }
  return out.slice(0, max);
}

const LEARN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rules'],
  properties: {
    rules: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'commentIds'],
        properties: {
          text: { type: 'string', description: 'One imperative sentence a reviewer can apply, e.g. "Validate request bodies with zod in API routes"' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Glob(s) where it applies, if it is specific to part of the repo' },
          commentIds: { type: 'array', items: { type: 'integer' } },
        },
      },
    },
  },
};

const LEARN_SYSTEM = `You read a team's past code review comments and extract the standards they actually enforce.

Only propose a rule when at least two different comments ask for the same thing. Prefer rules about correctness, security, architecture and team conventions over formatting. Skip anything a formatter or linter would already enforce. Write each rule as one imperative sentence a reviewer can check in a diff. Cite the ids of the comments that support it. Ten rules at most; fewer is fine.`;

export async function proposeRules(provider: Provider, comments: ReviewComment[]): Promise<ProposedRule[]> {
  if (comments.length < 2) return [];
  const list = comments.map((c) => `#${c.id} (${c.path || 'general'}, @${c.author}): ${c.body.replace(/\s+/g, ' ')}`).join('\n');
  const r = await provider.complete({
    system: LEARN_SYSTEM,
    prompt: redactBlock(`Review comments from this repository's pull requests:\n\n${list}`),
    schema: LEARN_SCHEMA,
    purpose: 'chat',
    maxTokens: 8000,
  });
  const byId = new Map(comments.map((c) => [c.id, c]));
  const rules = ((r.json as { rules?: { text: string; paths?: string[]; commentIds: number[] }[] }).rules ?? [])
    .map((x) => ({ text: String(x.text ?? '').trim(), paths: x.paths?.filter(Boolean), evidence: (x.commentIds ?? []).map((id) => byId.get(id)).filter((c): c is ReviewComment => !!c) }))
    // A rule must be backed by at least two real comments we actually sent.
    .filter((x) => x.text && x.evidence.length >= 2);
  return rules.slice(0, 10);
}
