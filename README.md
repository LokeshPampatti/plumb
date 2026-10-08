# Plumb

AI code review that shows its work.

Plumb reviews your change before you commit it. Run it locally, in CI, or from your coding agent. Every finding cites the lines that prove it. Every model finding gets checked by a second, skeptical pass. You see the cost before any money is spent, and the team's preferences live in a file in your repo that you can read and revert.

```
$ plumb review --static
1/5  Critical problems, rethink before merging   risk: critical

src/payments/charge.ts
  P0 L2 Possible Stripe live secret key committed in plain text
     secret · proven by static analysis
   ▌    2    const stripeKey = "sk_l…************";

  P1 L1 `charge()` now takes 3 arguments, but 2 callers still pass the old shape
     contract · proven by static analysis
     evidence:
       src/api/checkout.ts:4 caller passes 2, missing `idempotencyKey` (file not in this diff)
       src/api/refund.ts:2  caller passes 2, missing `idempotencyKey` (file not in this diff)

Blast radius
  charge (src/payments/charge.ts:1, signature)  2 callers, 2 outside the diff, no test calls it

Score
   -2.50  P0 Possible Stripe live secret key committed in plain text
   -1.00  P1 `charge()` now takes 3 arguments, but 2 callers still pass the old shape
   -0.50  issues in a critical-risk change (src/auth/session.ts has been reverted 1x)

static checks only, $0 · 0.1s
```

Both of those bugs were caught in 0.1 seconds, for $0, with no model involved. The two broken callers are in files the change never touched, so a reviewer who only reads the diff won't see them. Try it with `sh examples/demo.sh`.

## Quick start

```bash
npm install && npm run build
npm link            # puts `plumb` on your PATH
cd your-repo
plumb init          # writes .plumb/config.json, rules.md, memory.json
plumb review        # everything uncommitted, vs HEAD
```

Pick a model in `.plumb/config.json`, or per run:

| Provider | What it costs | Setup |
|---|---|---|
| `none` | $0. Static checks only | nothing |
| `claude-code` | $0 in API fees, uses your Claude plan | Claude Code installed and logged in |
| `ollama` | $0, fully local | `ollama serve` and a code model |
| `anthropic` | Per token, shown before the run | `ANTHROPIC_API_KEY` |
| `openai` | Per token, shown before the run | `OPENAI_API_KEY` |

The default Anthropic model is `claude-opus-5-5` at high effort, with prompt caching on the shared repo context and the API's server-side refusal fallback turned on.

## How a review works

1. **Index.** Plumb parses the repo with tree-sitter (TypeScript, JavaScript, Python, Go, Java, Kotlin, Rust, C#, PHP, C, C++, Swift, Scala; Ruby through a line-based fallback) into a graph of definitions, calls and imports. Results are cached by content hash, so a 13,600-file Sentry checkout indexes in about 24 seconds cold and a second or two after that.
2. **Prove what can be proven.** Deterministic checks run first and cost nothing:
   - a function's parameters changed, and callers elsewhere still pass the old arguments
   - a symbol was removed or renamed, and another file still imports or calls it
   - a file was deleted or moved, and something still imports its old path
   - an added import names something the target module doesn't define
   - an added call doesn't match the signature it resolves to
   - secrets in added lines (AWS, GitHub, Stripe, Anthropic, OpenAI, Slack, Supabase service keys, private keys, DB URLs, high-entropy assignments)
3. **Gather context.** For each changed file the model gets the numbered diff, the full text of every changed function, the callers the graph found (with surrounding lines), the signatures of what the new code calls, what static analysis already proved, the file's history (reverts, fix density), and your rules and instruction files (CLAUDE.md, AGENTS.md, `.cursor/rules`, CONTRIBUTING.md).
4. **Find.** The finder model reports defects with a line anchor, evidence locations, impact, and a fix. With `--votes 3`, three independent samples run and only findings most of them agree on survive.
5. **Try to disprove it.** A separate skeptic pass gets the same context and tries to refute each finding. Refuted findings are dropped. Uncertain P2s are dropped. Uncertain P0/P1s stay, labelled unverified. `--show-refuted` lists what got thrown out and why.
6. **Check against reality.** Findings that point outside the diff are dropped. Evidence snippets are re-read from disk, so the text you see is your code, not something the model wrote.
7. **Apply memory, score, gate.** See below.

## Where it's different from Greptile

Everything in the Greptile column comes from Greptile's own docs (October 2026). Details and quotes are in [docs/greptile-teardown.md](docs/greptile-teardown.md).

| | Greptile | Plumb |
|---|---|---|
| Review uncommitted work | No. The CLI "ignores uncommitted changes" | Default mode. Also `--staged`, `--branch`, `--range` |
| Account | Required, even for the CLI | None |
| Cost | $30/seat/month, then $1 per review. Plus = 3 credits, Apex = 10 | Free and open source. Bring any model, or run static checks for $0 |
| Know the cost first | No preview; their troubleshooting covers reviews that "cost 3 or 10 credits instead of 1" | Estimate before every paid run, plus a hard per-review cap |
| False positives | Third-party benchmarks report more noise than competitors | Skeptic pass on every model finding, optional majority voting, evidence re-read from disk |
| Bugs outside the diff | Inline comments only reach diff lines | Deterministic contract checks, plus a "Problems outside this diff" section in the PR summary |
| Score | 0-5 | 0-5 with every deduction itemized |
| Auto-approve | "A withheld approval is silent" | Every decision says why, approve or not |
| Learning | 2-3 weeks of reactions, stored in the dashboard | Instant. Rules live in `.plumb/memory.json`, get reviewed in PRs, and revert with one command. P0, security, secret and contract findings can't be silenced |
| Whose config applies | `greptile.json` is read from the PR's branch | Config, rules, memory and instruction files (CLAUDE.md, AGENTS.md) come from the base branch, so a PR can't loosen its own review or prompt-inject the reviewer |
| Secrets and the model | The CLI holds back files that look sensitive | Secret values are redacted from every prompt and every output |
| Big PRs | Docs advise splitting large PRs | Suggests a dependency-ordered split |
| Reviewers | Not in docs | Suggests people from git history of the touched files |
| CI formats | PR comments | PR comments, SARIF 2.1.0 (GitHub code scanning), Markdown, JSON, HTML |
| Analytics | Hosted dashboard | `plumb stats`, local: addressed rate, fixed vs dismissed, what the skeptic threw out |

What Greptile has that Plumb doesn't: a hosted team dashboard, Jira/Linear/Confluence context, a sandboxed test runner (T-Rex), GitLab/Bitbucket/Perforce support, SSO and SOC 2. Plumb is a developer tool, not yet a hosted product.

## Commands

```
plumb review [paths...]        review uncommitted changes (default)
  --staged | --branch [base] | --range a..b
  --static                     no model calls
  --provider, --model, --effort, --verifier-model
  --votes 3                    majority vote across 3 finder samples
  --budget 0.50                hard cap for this run
  --estimate                   print the cost estimate and stop
  --strictness 1|2|3           verbose / balanced / critical only
  -i "focus on the retry logic"
  --json | --md | --sarif out.sarif | --html report.html
  --fail-on P0                 exit 1 for CI or hooks
plumb impact <symbol | file | file:line>   who calls this?
plumb dismiss <id> -r "reason" [--scope file|dir|repo] [--downgrade]
plumb remember "We use Result<T>, not exceptions, in src/payments"
plumb memory [list | forget <id>]
plumb fix-prompt               hand the last review to a coding agent
plumb stats                    addressed rate, fixed vs dismissed, by category
plumb hook install             pre-push hook: static checks, blocks P0
plumb github                   run inside GitHub Actions
plumb mcp                      MCP server for Claude Code, Cursor, Codex
```

## Memory

`plumb dismiss <id> -r "we use short names in tight loops"` turns a finding into a scoped rule:

```json
{
  "id": "m_3f9a1c",
  "kind": "suppress",
  "text": "we use short names in tight loops",
  "match": { "category": "style", "paths": ["src/cart/**"], "keywords": ["accumulator", "name", "unclear"] },
  "evidence": [{ "date": "2026-10-07", "finding": "a41c...", "file": "src/cart/total.ts" }]
}
```

It takes effect on the next run. Every review lists what memory hid and which rule hid it. In GitHub, replying `/plumb dismiss <reason>` to a finding commits the rule to the PR branch, so the lesson gets reviewed like any other change. `plumb remember` adds preferences the reviewer should follow.

## Score and merge gate

The score starts at 5. A P0 costs 2.5, a P1 costs 1, P2s cost 0.25 each up to 1 total. Unverified findings count 60%. Serious findings in a critical-risk change cost another 0.5. The full ledger is printed every time.

Risk comes from what the change touches: sensitive paths (auth, billing, migrations, CI, infra), dependency manifests, size, and history (reverts and fix-heavy files). Auto-approve (`autoApprove` in config) requires a 5/5 score, risk under your ceiling, no protected paths, no draft or `do-not-merge` label, and no human "changes requested". The reasons are always printed.

## GitHub Action

See [examples/plumb-workflow.yml](examples/plumb-workflow.yml). On each PR it keeps one summary comment up to date, posts inline comments only for new findings, resolves threads whose finding no longer reproduces, lists problems outside the diff in the summary, and approves when the gate passes. `/plumb review <instructions>` re-runs it. `/plumb dismiss <reason>` teaches it.

## MCP

```json
{ "mcpServers": { "plumb": { "command": "plumb", "args": ["mcp"] } } }
```

Tools: `plumb_review` (static by default, model on request), `plumb_impact` (callers of a symbol), `plumb_findings` (the last review as a fix prompt), `plumb_dismiss`.

## Benchmark

`bench/` reproduces Greptile's public benchmark: the same 50 bug-introducing PRs from Sentry, Cal.com, Grafana, Keycloak and Discourse, pinned to the merge-base and head commits of each public fork. Scoring matches theirs: a bug counts only if a line-level finding identifies it. The harness also records findings per PR, because catch rate alone rewards noisy reviewers.

```bash
npx tsx bench/run.ts --static                        # $0
npx tsx bench/run.ts --provider claude-code          # your Claude plan
npx tsx bench/run.ts --provider anthropic --budget 1 --yes
```

Results land in `bench/results/`.

## Status

Working: everything above, covered by 29 tests (diff parsing, extraction across languages, every static check, the full pipeline with a scripted model, secret hygiene, the trust model, the GitHub flow against a fake API, and the MCP server over stdio).

Not done yet: a live model run of the full benchmark, GitLab and Bitbucket, a hosted dashboard, a sandboxed test runner, learning from historical PR review comments.

## License

MIT
