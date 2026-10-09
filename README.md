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

Both of those bugs were caught in about 0.2 seconds, for $0, with no model involved. The two broken callers are in files the change never touched, so a reviewer who only reads the diff won't see them. Try it with `sh examples/demo.sh`.

## Quick start

```bash
git clone https://github.com/LokeshPampatti/plumb && cd plumb
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
| `claude-code` | $0 in API fees, uses your Claude plan | Claude Code installed and logged in (tested against a stub CLI so far) |
| `ollama` | $0, fully local | `ollama serve` and a code model |
| `anthropic` | Per token, shown before the run | `ANTHROPIC_API_KEY` |
| `openai` | Per token, shown before the run | `OPENAI_API_KEY` |
| `exchange` | $0 in API fees | Something that answers request files: Plumb writes `req-<id>.md` to `PLUMB_EXCHANGE_DIR` and waits for `res-<id>.json` (an agent, a script, or a person) |

The default Anthropic model is `claude-opus-5-5` at high effort, with prompt caching on the shared repo context and the API's server-side refusal fallback turned on.

## How a review works

1. **Index.** Plumb parses the repo with tree-sitter (TypeScript, JavaScript, Python, Go, Java, Kotlin, Rust, C#, PHP, C, C++, Swift, Scala; Ruby through a line-based fallback) into a graph of definitions, calls and imports. Results are cached by content hash, so a 13,600-file Sentry checkout indexes in about 31 seconds cold and about 7 seconds once cached.
2. **Prove what can be proven.** Deterministic checks run first and cost nothing:
   - a function's parameters changed, and callers elsewhere still pass the old arguments
   - a symbol was removed or renamed, and another file still imports or calls it
   - a file was deleted or moved, and something still imports its old path
   - an added import names something the target module doesn't define
   - an added call doesn't match the signature it resolves to
   - secrets in added lines (AWS, GitHub, Stripe, Anthropic, OpenAI, Slack, Supabase service keys, private keys, DB URLs, high-entropy assignments)
3. **Ask your own toolchain.** If the project has `tsc`, `go vet` or `ruff` installed, Plumb runs them (type checks and correctness rules only, nothing executes) and keeps errors on lines the change added. Errors that were already there aren't blamed on this change.
4. **Gather context.** For each changed file the model gets the numbered diff, the full text of every changed function, the callers the graph found (with surrounding lines), the signatures of what the new code calls, what static analysis already proved, the file's history (reverts, fix density), and your rules and instruction files (CLAUDE.md, AGENTS.md, `.cursor/rules`, CONTRIBUTING.md).
5. **Find.** The finder model reports defects with a line anchor, evidence locations, impact, and a fix. With `--votes 3`, three independent samples run and only findings most of them agree on survive. `--depth deep` also runs three focused passes (security, concurrency, data integrity) whose findings go through the same skeptic.
6. **Try to disprove it.** A separate skeptic pass gets the same context and tries to refute each finding. Refuted findings are dropped. Uncertain P2s are dropped. Uncertain P0/P1s stay, labelled unverified. `--show-refuted` lists what got thrown out and why.
7. **Check against reality.** Findings that point outside the diff are dropped. Evidence snippets are re-read from disk, so the text you see is your code, not something the model wrote.
8. **Prove it by running it (opt-in).** With `--repro`, the model writes a minimal failing test for each P0/P1 in your project's own framework (vitest, jest, node:test, pytest, go test). Plumb runs it and deletes it. A test that fails on an assertion marks the finding **reproduced**; a test that passes marks it **not reproduced** and lowers its weight. This runs model-written code on your machine, so it is off unless you ask.
9. **Apply memory, score, gate.** See below.

## Design choices

Plumb started as a way to learn the problem Greptile works on: build a reviewer from scratch, then measure it on Greptile's public benchmark. Along the way it settled on these choices:

| Choice | What it means in practice |
|---|---|
| Review before you commit | The default mode reviews uncommitted work. `--staged`, `--branch` and `--range` cover the rest, and `--pr <url>` reviews any GitHub PR without a clone |
| Prove what can be proven first | Contract checks and your own `tsc` / `go vet` / `ruff` run before any model call. Only errors on lines the change added are reported |
| Every model finding meets a skeptic | A second pass gets the same context and tries to refute each finding. `--votes 3` adds majority voting, and evidence is re-read from disk |
| Proof by execution, opt-in | `--repro` writes and runs a failing test locally for each P0/P1 finding |
| Cost before spend | Every paid run prints an estimate first and stops at a hard per-review cap. Static checks cost $0 |
| Bugs outside the diff | Callers broken in files the change never touched get reported, and PR summaries list them under "Problems outside this diff" |
| Config from the base branch | Config, rules, memory and instruction files (CLAUDE.md, AGENTS.md) come from the base branch, so a PR can't loosen its own review or prompt-inject the reviewer |
| Memory lives in the repo | Learned rules sit in `.plumb/memory.json`, get reviewed in PRs, and revert with one command. P0, security, secret and contract findings can't be silenced |
| Decisions explain themselves | The 0-5 score itemizes every deduction, and auto-approve always says why it did or didn't approve |
| Secrets stay out of prompts | Secret values are redacted from every prompt and every output |
| Output for any pipeline | PR comments, SARIF 2.1.0 for GitHub code scanning, Markdown, JSON and HTML |

What Plumb doesn't have: a hosted dashboard, Jira/Linear/Confluence context, a hosted test sandbox, Bitbucket or Perforce support, SSO, or SOC 2. It is a developer tool, not a hosted product, and on Greptile's benchmark it catches fewer bugs than Greptile does (results below).

## Commands

```
plumb review [paths...]        review uncommitted changes (default)
  --staged | --branch [base] | --range a..b
  --pr <url | owner/repo#N>    review a GitHub PR without cloning it
  --static                     no model calls
  --provider, --model, --effort, --verifier-model
  --depth quick|standard|deep  deep = security, concurrency and data passes + 3-way voting
  --votes 3                    majority vote across 3 finder samples
  --budget 0.50                hard cap for this run
  --estimate                   print the cost estimate and stop
  --strictness 1|2|3           verbose / balanced / critical only
  --repro [--keep-repro]       write + run a failing test per P0/P1 finding
  --no-toolchain               skip tsc / go vet / ruff
  -i "focus on the retry logic"
  --json | --md | --sarif out.sarif | --html report.html
  --fail-on P0                 exit 1 for CI or hooks
plumb impact <symbol | file | file:line>   who calls this?
plumb dismiss <id> -r "reason" [--scope file|dir|repo] [--downgrade]
plumb remember "We use Result<T>, not exceptions, in src/payments"
plumb learn owner/repo         propose rules from your team's past PR review comments
plumb memory [list | forget <id>]
plumb fix [ids] [--dry-run]    apply suggested fixes (only to lines unchanged since review)
plumb fix-prompt               hand the last review to a coding agent
plumb stats                    addressed rate, fixed vs dismissed, by category
plumb hook install             pre-push hook: static checks, blocks P0
plumb github                   run inside GitHub Actions
plumb gitlab                   run inside GitLab CI on merge requests
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

`plumb learn owner/repo` reads the human review comments in the repo's PR history and proposes rules your team already enforces. A rule needs at least two real comments behind it, each one links back to the comment it came from, and you approve rules one at a time before anything is saved.

## Score and merge gate

The score starts at 5. A P0 costs 2.5, a P1 costs 1, P2s cost 0.25 each up to 1 total. Unverified findings count 60%. Serious findings in a critical-risk change cost another 0.5. The full ledger is printed every time.

Risk comes from what the change touches: sensitive paths (auth, billing, migrations, CI, infra), dependency manifests, size, and history (reverts and fix-heavy files). Auto-approve (`autoApprove` in config) requires a 5/5 score, risk under your ceiling, no protected paths, no draft or `do-not-merge` label, and no human "changes requested". The reasons are always printed.

## GitHub Action

See [examples/plumb-workflow.yml](examples/plumb-workflow.yml). On each PR it keeps one summary comment up to date, posts inline comments only for new findings, resolves threads whose finding no longer reproduces, lists problems outside the diff in the summary, and approves when the gate passes. `/plumb review <instructions>` re-runs it. `/plumb dismiss <reason>` teaches it.

## GitLab

See [examples/gitlab-ci.yml](examples/gitlab-ci.yml). Same behavior on merge requests: one summary note kept up to date, inline discussions for new findings only, discussions resolved when their finding no longer reproduces, and approval when the gate passes. Needs a `GITLAB_TOKEN` CI variable (project access token with the `api` scope).

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
npx tsx bench/run.ts --provider exchange             # answer the requests with your own agents
npx tsx bench/run.ts --provider anthropic --budget 1 --yes
```

Results land in `bench/results/`. `npx tsx bench/aggregate.ts <runs...> --deep <deep runs>` merges them into `bench/results/SUMMARY.md`.

### Results (2026-10-08)

All 50 PRs, with Claude Opus as the model. The model calls went to Claude Code sub-agents through the `exchange` provider, one fresh agent per call, so the run cost $0 in API fees. A separate fresh agent graded each PR. It saw only the known bug and Plumb's findings, and a finding counted only if it named the same root cause at the code that has it.

| Tool | Bugs caught (of 50) |
|---|---|
| Greptile | 41 |
| Cursor | 29 |
| Copilot | 26 |
| Plumb, default depth | 24 |
| CodeRabbit | 22 |
| Graphite | 3 |

The other tools' numbers come from Greptile's own published table. They were not rerun here.

Plumb averaged 2.3 findings per PR. In 18 of its 26 misses it reported other problems in the same PR instead of the labeled bug; the benchmark scores only the labeled one, so those findings count for nothing here, and beyond Plumb's own skeptic pass nobody has checked whether they are real. The finder prompt tells the model to skip naming and style issues and to favor precision over recall, and several labeled bugs fall in that zone (a metric tag spelled `shard` in one place and `shards` in another, a CSS float inside a flexbox). On this benchmark that trade costs recall. A higher-recall mode is the obvious next step, and it should be measured on PRs outside these 50 so it isn't tuned to the answer key.

`--depth deep` (three independent finders plus security, concurrency and data passes) was rerun on 22 of the 26 misses and caught 3 more: cal.com-5, grafana-10 and discourse-8. That makes 27 of 50, scored separately from the default run. sentry-5, sentry-6, sentry-9 and keycloak-5 were not rerun because their diffs split into many batches and each would have cost dozens of model calls.

Caveats worth knowing before quoting these numbers:

- sentry-1's label says the PR imports a `OptimizedCursorPaginator` that doesn't exist, but the PR defines that class in `paginator.py`.
- The discourse-7 grade was a close call. The bug text names no file, and all four of Plumb's findings were about the same lightness mismatch.
- grafana-3 is a Go compile error that `go vet` would catch, but Go was not installed on the machine that ran this, so the toolchain layer skipped it.
- Plumb caught one bug Greptile's table marks as missed (sentry-2, negative cursor offsets).

The per-PR table is in [bench/results/SUMMARY.md](bench/results/SUMMARY.md).

## Status

Working: everything above, covered by 39 tests (diff parsing, extraction across languages, every static check, the full pipeline with a scripted model, secret hygiene, the trust model, the toolchain layer, repro runs against real test files, the GitHub and GitLab flows against fake APIs, and the MCP server over stdio).

Not done yet: a higher-recall review mode measured on held-out PRs, Bitbucket, a hosted dashboard, sandboxing for `--repro`.

## License

MIT
