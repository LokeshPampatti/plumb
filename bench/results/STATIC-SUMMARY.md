# Static layer on Greptile's 50-PR benchmark (2026-10-07)

Mode: `--static`. No model calls, $0. All 50 PRs pinned to merge-base..head of the public `ai-code-review-evaluation/*-greptile` forks.

## First full run

4 findings across 50 PRs (0.08 per PR):

| Case | Finding | Verdict |
|---|---|---|
| keycloak-1 | `isConditionalPasskeysEnabled()` called without its `user` argument | **Correct. This is the planted bug.** Greptile was the only other tool to catch it |
| keycloak-1 | `USER_SET_BEFORE_USERNAME_PASSWORD_AUTH` flagged as a hard-coded secret | False positive: a constant whose value is its own name |
| grafana-6 | `recordLegacyDuration()` missing arguments | False positive: the call site was `go func(){...}()`, an anonymous function |
| grafana-6 | `recordStorageDuration()` missing arguments | False positive, same cause |

## After fixes

Both false-positive classes were fixed with regression tests (anonymous callees never resolve to a name; secret-named constants need a credential-shaped value). Both changes can only remove findings, so the other 48 PRs stay at 0. Re-running the two affected PRs:

- grafana-6: 0 findings
- keycloak-1: 1 finding, the planted bug

**Static layer after fixes: 1 finding in 50 PRs, and it is a real bug. 1/50 caught for $0.**

The static layer is built for precision, not recall. Most benchmark bugs are semantic (wrong condition, race, missing invalidation) and need the model layer. See the live runs for the full Plumb numbers.

Raw output: `2026-10-07T23-28-06-094Z.json` / `.md` (pre-fix code).
