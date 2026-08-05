# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- DESIGN.md and PLAN.md at the repo root are authoritative; the semantic contract in DESIGN.md section 2 must never be violated, and milestone scope/test tables live in PLAN.md.
- Commands (repo root): `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. All must be green before a milestone is done.
- `packages/core` has zero runtime dependencies and never touches the wall clock: no `Date.now`, `Math.random`, or global timers (eslint enforces this). The single sanctioned exception is `src/system-clock.ts`, which provides the default `systemClock`/`systemRandom`; `clock` and `random` stay injectable and tests use `FakeClock` from core - no sleeps, no wall-clock dependence.
- Every Store adapter must pass `storeContractSuite` from `@datafridge/core/contract-tests` (see `packages/core/test/contract.test.ts` for usage). The suite documents claim/version/lease semantics beyond the type signatures, including create-on-claim at expectedVersion 0.
- Invalid configuration fails at construction (`defineQueries`, `createPoller` resolution rules), never at runtime.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
