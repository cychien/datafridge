# M4 accelerated dogfood acceptance

## Scope

Captain superseded the original multi-day observation with an accelerated production run. The accepted consumer used a real Cloudflare Worker, Durable Object alarms, D1, and the genuine PostHog Query API. Private Worker wiring, account and project identifiers, credentials, query definitions, result payloads, and operational logs remain in the private consumer repository.

The consumer's corrected baseline passed Workers Vitest, E2E, typecheck, Biome, production build, and Wrangler dry-run before the accepted observation window.

## Observation window

- Start: `2026-08-06T06:24:00Z`
- End: `2026-08-06T06:34:48Z`
- End condition: the controlled failure had recovered on schedule, all expected fixed and parameterized envelopes had refreshed, and browser smoke checks passed.
- Manual intervention: one preplanned upstream fault was deliberately introduced. Refresh scheduling, backoff, stale serving, and recovery then completed without a manual retry, refresh, or data repair.

## Sanitized evidence

| Signal | Result |
|---|---:|
| Durable Object alarm ticks | 162 |
| Successful query runs | 202 |
| Parameterized query runs | 20 |
| Maximum successful runs in one tick | 2 |
| `skippedLeased` | 0 |
| Deliberate failures | 1 |
| Fixed envelopes refreshed | 54 of 54 |
| Isolated-course variants refreshed | 5 of 5 |

No secret, private parameter, query result, account identifier, project identifier, D1 identifier, or credential is included in this record.

## Contract verification

- **Repeated alarm cycles:** 162 ticks completed during the window and the alarm chain remained live through the controlled failure.
- **Parameterized variants:** all five isolated-course variants refreshed independently, producing 20 successful parameterized runs. Storage and reports used hashed identities rather than raw params.
- **Lease and concurrency:** Combo A is serialized, so zero skipped leases is the expected healthy result. No duplicate execution was observed, and the source budget held successful work to at most two runs per tick. Deterministic core and Durable Object tests separately cover live-lease rejection, expired-lease reclaim, concurrent claims, and zombie write rejection.
- **Stale-if-error and backoff:** the deliberate upstream failure retained the prior envelope and recorded exactly one error. No retry occurred inside 30 seconds, matching scheduled backoff rather than an immediate retry loop.
- **Recovery:** the next scheduled recovery succeeded and cleared the prior error without manual retry or data repair.
- **Read paths:** browser smoke passed fixed preset reads from D1, course-scoped preset reads from independent parameterized D1 envelopes, and custom-range reads that intentionally remain live and outside datafridge.
- **Construction and release gates:** the consumer passed its Worker test, E2E, typecheck, formatting/lint, production build, and Wrangler dry-run gates. The datafridge repository separately verifies lint, typecheck, deterministic tests, builds, reproducible package archives, declarations, migrations, subpath imports, CLI execution, and clean consumer installation.

This evidence accepts M4 dogfood behavior only. npm publication, package tags, and GitHub releases remain separately captain-gated and must run from merged, reviewed code.
