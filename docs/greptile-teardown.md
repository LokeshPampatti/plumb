# Greptile teardown (October 2026)

Research for Plumb. Sources: Greptile's public docs (53 pages pulled from `greptile.com/docs/llms.txt` on 2026-10-07), pricing page, changelog, their public benchmark, and third-party comparisons. I did not create an account, so nothing here comes from inside the product.

## What Greptile is

An AI code reviewer that comments on pull requests in GitHub, GitLab, Bitbucket, Gitea, Cursor Origin and Perforce. YC W24, founded by three Georgia Tech alumni (Daksh Gupta, Soohoon Choi, Vaishant Kameshwaran). Claims 22,000+ teams, including Brex, Substack, PostHog, NVIDIA and Zapier.

## Feature inventory

| Area | What they ship | Source |
|---|---|---|
| Context | Builds a graph of the repo (functions, classes, imports, calls) and queries it during review | docs: graph-based-codebase-context |
| Review output | PR summary, 0-5 confidence score, file-by-file breakdown, auto-picked Mermaid diagram, inline comments with P0/P1/P2 badges, suggested fixes | docs: first-pr-review |
| Review tiers | Base (1 credit), Plus (3), Apex (10), Auto picks per PR. Rules can force a tier by label, branch, path or size | docs: review-tiers, changelog 2026-09-25 |
| T-Rex | Writes and runs tests in a sandbox, attaches logs and screenshots. Beta. Not compatible with Plus, Apex or Auto | docs: key-features, review-tiers |
| Learning | 👍/👎 reactions, replies, and first-vs-last-commit "was it addressed" analysis. Suppresses a comment type after about 3 ignores. Takes 2-3 weeks to adapt | docs: memory-and-learning, nitpicks, developer-essentials |
| Knowledge base | Auto-written docs per repo: architecture index, per-area docs, a section of past reverts and incidents | docs: knowledge-bases |
| Rules | Plain-English rules in the dashboard, `greptile.json`, or cascading `.greptile/` folders. Auto-detects CLAUDE.md and `.cursor/rules` | docs: custom-standards, greptile-config, changelog v3 |
| Noise control | `strictness` 1-3, `commentTypes` (logic, syntax, style), ignore patterns, triggers | docs: controlling-nitpickiness |
| Auto-approve | Beta. Approves only clean 5/5 reviews under a risk ceiling (low, medium, high, critical), with path, label, branch and author filters | docs: auto-approve-prs |
| Agent handoff | "Fix with your Agent" buttons for Claude Code, Codex, Conductor, Cursor, Devin. MCP server. Claude Code and Codex plugins | docs: fix-with-your-agent, mcp-v2 |
| CLI | `greptile review` against the default branch, `--plus/--apex`, JSON output, status exit codes | docs: greptile-cli |
| Cross-repo | `context.repos` and Repo Clusters (up to 20 GB) | docs: cross-repo-context |
| Integrations | Jira, Confluence, Linear | docs |
| Analytics | PRs reviewed, merge time, addressed rate, critical bugs caught, upvote ratio | docs: analytics |
| Enterprise | SOC 2 Type II, self-host (Docker Compose, Kubernetes, air-gapped), SSO/SAML | docs: deployment-options |

## Pricing

- Starter: free, 1 active developer, 50 credits a month
- Pro: $30 per seat per month, 50 credits per seat, $1 per extra credit. Plus costs 3 credits and Apex costs 10
- Enterprise: custom; self-hosting lives here
- 50% off for pre-Series A startups, free for qualifying open source

## Gaps, in their own words

These come straight from Greptile's docs, not from competitors.

1. **No review of uncommitted work.** The CLI "reviews committed changes that have not been merged. It ignores uncommitted changes." The tips page still lists local review without a PR as "on our roadmap".
2. **The CLI needs an account and credits.** `greptile login` or an API key, and every run spends credits. CLI runs default to Base whatever the repo sets.
3. **Silent auto-approve.** "A withheld approval is silent. Greptile does not comment to explain why it did not approve."
4. **Slow, opaque learning.** "It takes 2-3 weeks of consistent reactions." The rules it infers live in the dashboard, not in the repo.
5. **Config comes from the PR branch.** "Greptile reads greptile.json from the source branch of the PR." (Auto-approve policy is the exception: it reads from the base branch.) So a PR can change its own review settings.
6. **Some settings are dashboard-only.** Excluded authors: "This is dashboard-only, not available in greptile.json."
7. **Surprise costs.** Troubleshooting has an entry for "Review ran at a higher tier than expected… A review cost 3 or 10 credits instead of 1." There's no cost preview before a review runs.
8. **T-Rex is limited to Base.** Not compatible with Plus, Apex or Auto.
9. **Big PRs.** The advice for slow reviews is "break down PRs" and "split large changes", but the product doesn't suggest how.
10. **Inline comments only reach the diff.** Code-host APIs only accept comments on diff lines, so a caller broken in an untouched file has nowhere to go inline.

## What third parties say

- **Noise.** In one independent comparison, Greptile left 11 false positives where CodeRabbit left 2 (surmado.com, 2026). Panto, a competitor, claims close to 60% of Greptile comments are nitpicks or false positives. Treat both with suspicion, but the theme repeats across reviews.
- **Pricing.** Per-seat billing plus overages is the most common complaint for small teams.
- **Cursor Bugbot** runs 8 passes with majority voting to cut noise, which is the clearest competing answer to the noise problem.

## Greptile's own benchmark

`greptile.com/benchmarks`: 50 real bug-introducing PRs from Sentry (Python), Cal.com (TypeScript), Grafana (Go), Keycloak (Java) and Discourse (Ruby). Each tool's run is public under `github.com/ai-code-review-evaluation`. A bug counts only if a line-level comment identifies it and explains the impact.

Published catch rates: Greptile 82% (41/50), Cursor 58%, Copilot 54%, CodeRabbit 44%, Graphite 6%. The nine bugs Greptile missed by its own table: sentry-2 (negative offset cursor), sentry-4 (OAuth null state), cal.com-2 (2FA backup codes reusable), cal.com-8 (OR condition deletes all reminders), grafana-2 (cache entries never expire), grafana-4 (double interpolation), keycloak-4 (wrong exit-code call), keycloak-5 (orphaned permissions), discourse-5 (float inside flexbox).

The benchmark measures recall only. It doesn't count false positives, which is the main complaint about Greptile in the field. Plumb's harness (`bench/run.ts`) records findings per PR next to the catch rate so both sides show up.

## What this means for Plumb

Greptile's moat is the hosted product: integrations, enterprise deployment, and the dashboard. Plumb doesn't try to beat that. It goes after the developer-facing gaps above: run before you commit, prove every claim, show what you'll pay, explain every decision, and keep the team's memory in the repo where it can be reviewed.
