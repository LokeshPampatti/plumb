# Plumb on Greptile's benchmark: 50 of 50 PRs

Default depth: Plumb caught **24/50** (48%), 1 of them with $0 static analysis. Avg 2.3 findings per PR.

Greptile's own published table, same 50 PRs: greptile 41, cursor 29, copilot 26, **plumb** 24, coderabbit 22, graphite 3.

Plumb caught, Greptile missed: sentry-2.
Greptile caught, Plumb missed: sentry-1, sentry-3, sentry-5, sentry-6, sentry-9, cal.com-4, cal.com-5, cal.com-7, grafana-3, grafana-8, grafana-10, keycloak-2, keycloak-3, keycloak-9, keycloak-10, discourse-6, discourse-8, discourse-9.

| Case | Bug | Plumb | How | Greptile | Others |
|---|---|---|---|---|---|
| sentry-1 | Importing non-existent OptimizedCursorPaginator | — |  | ✅ |  |
| sentry-2 | Negative offset cursor manipulation bypasses pagination boundaries | ✅ | model | — | coderabbit, cursor |
| sentry-3 | sample_rate = 0.0 is falsy and skipped | — |  | ✅ |  |
| sentry-4 | Null reference if github_authenticated_user state is missing | — |  | — | copilot, cursor |
| sentry-5 | Breaking changes in error response format | — |  | ✅ |  |
| sentry-6 | Inconsistent metric tagging with 'shard' and 'shards' | — |  | ✅ | copilot |
| sentry-7 | Shared mutable default in dataclass timestamp | ✅ | model | ✅ | copilot, coderabbit, cursor |
| sentry-8 | Using stale config variable instead of updated one | ✅ | model | ✅ | coderabbit |
| sentry-9 | Invalid queue.ShutDown exception handling | — |  | ✅ | copilot |
| sentry-10 | Incomplete implementation (only contains pass) | ✅ | model | ✅ | cursor |
| cal.com-1 | Async callbacks in forEach creates unhandled promise rejections | ✅ | model | ✅ | copilot, coderabbit, cursor |
| cal.com-2 | Backup codes not invalidated after use | — |  | — | coderabbit |
| cal.com-3 | Null reference error if array is empty | ✅ | model | ✅ | copilot, cursor |
| cal.com-4 | Potential SQL injection risk in raw SQL query construction | — |  | ✅ | copilot |
| cal.com-5 | Missing database cleanup when immediateDelete is true | — |  | ✅ | cursor |
| cal.com-6 | Incorrect end time calculation using slotStartTime instead of slotEndTime | ✅ | model | ✅ | copilot, coderabbit |
| cal.com-7 | Timing attack vulnerability using direct string comparison | — |  | ✅ |  |
| cal.com-8 | OR condition causes deletion of all workflow reminders | — |  | — | copilot, coderabbit, cursor |
| cal.com-9 | Case sensitivity bypass in email blacklist | ✅ | model | ✅ | copilot |
| cal.com-10 | Inaccurate cache status tracking due to unreliable updatedAt field | ✅ | model | ✅ | cursor |
| grafana-1 | Race condition in CreateOrUpdateDevice method | ✅ | model | ✅ |  |
| grafana-2 | Cache entries without expiration causing permanent permission denials | — |  | — | cursor |
| grafana-3 | Undefined endpoint constants causing compilation errors | — |  | ✅ |  |
| grafana-4 | Double interpolation risk | — |  | — | copilot, cursor |
| grafana-5 | Missing key prop causing React rendering issues | ✅ | model | ✅ | coderabbit, cursor |
| grafana-6 | Incorrect metrics recording methods causing misleading performance tracking | ✅ | model | ✅ | copilot, coderabbit, cursor, graphite |
| grafana-7 | Incorrect error level logging | ✅ | model | ✅ | copilot, coderabbit, graphite |
| grafana-8 | Deadlock potential during concurrent annotation deletion operations | — |  | ✅ | copilot, coderabbit, cursor |
| grafana-9 | enableSqlExpressions function always returns false, disabling SQL functionality | ✅ | model | ✅ | copilot, coderabbit, cursor, graphite |
| grafana-10 | Race condition in cache locking | — |  | ✅ | cursor |
| keycloak-1 | ConditionalPasskeysEnabled() called without UserModel parameter | ✅ | static | ✅ |  |
| keycloak-2 | Recursive caching call using session instead of delegate | — |  | ✅ |  |
| keycloak-3 | Returns wrong provider (default keystore instead of BouncyCastle) | — |  | ✅ | coderabbit |
| keycloak-4 | Incorrect method call for exit codes | — |  | — |  |
| keycloak-5 | Inconsistent feature flag bug causing orphaned permissions | — |  | — | cursor |
| keycloak-6 | Incorrect permission check in canManage() method | ✅ | model | ✅ | copilot, coderabbit, cursor |
| keycloak-7 | Lithuanian translation files contain Italian text | ✅ | model | ✅ | copilot, coderabbit, cursor |
| keycloak-8 | Wrong parameter in null check (grantType vs. rawTokenId) | ✅ | model | ✅ | copilot, coderabbit, cursor |
| keycloak-9 | Unsafe raw List deserialization without type safety | — |  | ✅ | coderabbit, cursor |
| keycloak-10 | Missing null check causing NullPointerException | — |  | ✅ | copilot, cursor |
| discourse-1 | Method overwriting causing parameter mismatch | ✅ | model | ✅ | copilot, coderabbit, cursor |
| discourse-2 | Nil reference non-existent TopicUser | ✅ | model | ✅ | copilot, coderabbit, cursor |
| discourse-3 | BlockedEmail.should_block? modifies DB during read | ✅ | model | ✅ | cursor |
| discourse-4 | SSRF vulnerability using open(url) without validation | ✅ | model | ✅ | copilot, coderabbit, cursor |
| discourse-5 | Mixing float: left with flexbox causes layout issues | — |  | — | coderabbit |
| discourse-6 | String mutation with << operator | — |  | ✅ | copilot, cursor |
| discourse-7 | Inconsistent theme color lightness affects visibility | ✅ | model | ✅ | copilot, coderabbit, cursor |
| discourse-8 | Race conditions in async member loading | — |  | ✅ |  |
| discourse-9 | Thread-safety issue with lazy @loaded_locales | — |  | ✅ | copilot |
| discourse-10 | NoMethodError before_validation in EmbeddableHost | ✅ | model | ✅ | copilot, cursor |
