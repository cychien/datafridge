# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- DESIGN.md and PLAN.md at the repo root are authoritative; the semantic contract in DESIGN.md section 2 must never be violated, and milestone scope/test tables live in PLAN.md.
- Commands (repo root): `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. All must be green before a milestone is done.
- `packages/core` has zero runtime dependencies and never touches the wall clock: no `Date.now`, `Math.random`, or global timers (eslint enforces this). The single sanctioned exception is `src/system-clock.ts`, which provides the default `systemClock`/`systemRandom`; `clock` and `random` stay injectable and tests use `FakeClock` from core - no sleeps, no wall-clock dependence.
- Every Store adapter must pass `storeContractSuite` from `@datafridge/core/contract-tests` (see `packages/core/test/contract.test.ts` for usage). The suite documents claim/version/lease semantics beyond the type signatures, including create-on-claim at expectedVersion 0.
- Invalid configuration fails at construction (`defineQueries`, `createPoller` resolution rules), never at runtime.
- `packages/cloudflare` typechecks and tests against core's source (tsconfig `paths` + vitest `resolve.alias`) because CI runs test before build; the tsup build uses `tsconfig.build.json` and resolves core from dist via pnpm's topological build order.
- Cloudflare tests run on vitest 4 with the `cloudflareTest()` plugin from `@cloudflare/vitest-pool-workers` (no more `defineWorkersConfig`/`poolOptions`). Sharp edges: storage isolation is per test *file* (wipe D1 tables between tests), test files and the main worker do not share a module cache (inject test state into a DO via `runInDurableObject`), and due DO alarms auto-fire in workerd (await the ignition tick by polling, drive later ticks deterministically with `runDurableObjectAlarm`). `workerd` must stay in pnpm `onlyBuiltDependencies`.
- The installed `datafridge init` CLI lives in `@datafridge/cloudflare` as a node bin (DESIGN.md section 10: no extra package, no sibling deps); `smol-toml` stays a devDependency bundled into `dist/cli.js` via tsup `noExternal` so the package keeps zero runtime deps. Node-typed CLI code is fenced off from workers-typed code: `src/cli` is excluded from the workers tsconfigs and owned by `tsconfig.cli.json`, and its tests run in the separate `cloudflare-cli` vitest project (`test-cli/`, plain node) because the main cloudflare project forces the workers pool.
- The accepted parameterized-query slice is specified in DESIGN.md section 5. `queryKey` hashes canonical JSON into the reserved `@df/v1/` identity; params are snapshotted, must stay finite/non-secret, and each variant is an ordinary independent registry entry. Keep identity, reconcile, direct-read, and DO+D1 lifecycle coverage deterministic.
- Release readiness is checked by `pnpm release:check`; `.github/workflows/release.yml` only publishes from a captain-dispatched run on `main` through the protected `npm` environment. Unscoped names are not placeholder packages; see `docs/releasing.md`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
