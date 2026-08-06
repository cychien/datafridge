# Release process and package names

English only: this one is for maintainers.

This repository uses Changesets and a manually dispatched, post-merge GitHub Actions publish job that authenticates with npm Trusted Publishing. There is no npm token. The one exception is the first publication of `1.0.0`, which the captain performs locally because npm cannot register a trusted publisher for a package that does not exist yet. No release action should run from a feature branch.

## Package strategy

The installable public package graph contains exactly:

| Package | Initial planned release | Contents |
|---|---:|---|
| `@datafridge/core` | `1.0.0` | Engine, types, memory store, parameterized identity, deterministic utilities, and contract tests |
| `@datafridge/cloudflare` | `1.0.0` | D1 stores, Durable Object alarms, Cron Trigger shell, migration, and init CLI |

`@datafridge/cloudflare` declares `@datafridge/core` as a peer dependency. Changesets converts the workspace range to a public semver range in packed artifacts.

The unscoped names `datafridge` and `data-fridge` are brand-reservation intent only. They are not aliases, meta-packages, or members of the package graph. npm has no non-package name-reservation operation, so this project will not publish empty or placeholder packages to occupy them. Any future unscoped publication requires real user-facing semantics and a separate reviewed decision. Users should install only `@datafridge/core` and `@datafridge/cloudflare`.

## Local release checks

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm release:check
```

`release:check` validates the Changesets release plan, builds both packages, packs each twice, requires byte-identical archives, verifies declarations, migration, CLI, licenses, READMEs, and subpath exports, rejects source/test directories, installs both tarballs into a clean temporary npm consumer, imports core and Cloudflare subpaths, and runs the packaged CLI.

To inspect a tarball without publishing:

```sh
pnpm -C packages/core pack --pack-destination /tmp/datafridge-pack
pnpm -C packages/cloudflare pack --pack-destination /tmp/datafridge-pack
shasum -a 256 /tmp/datafridge-pack/*.tgz
```

Never put credentials, private analytics, or private consumer wiring into tarballs or release evidence.

## Automation

[`.github/workflows/release.yml`](../.github/workflows/release.yml) has two least-privilege jobs, each gated on its triggering event:

1. `version` runs only on a push to `main`. If changesets are pending it creates or updates the version PR; that PR must be reviewed and merged normally. If none are pending it succeeds as a no-op. The job passes no publish script, so it cannot publish.
2. `publish` runs only on a `workflow_dispatch` against `main`, which a captain triggers once the versioned packages are on `main`. Only that event can enter the `npm` environment.

The publish job checks out `main`, pins npm, installs with the lockfile, refuses to continue while any changeset is still pending, runs lint, typecheck, tests, and package verification, then calls Changesets publish. It uses a GitHub-hosted runner, Node 24, `id-token: write`, public `publishConfig`, and provenance. Actions are pinned by commit SHA with the corresponding tag noted alongside. The action creates package tags and GitHub releases only after publication.

`changesets/action` is pinned to `v1`, the line that supports the `@changesets/cli` v2 this repository installs. The `v2` action line requires `@changesets/cli` v3 and fails immediately against a v2 CLI, so the two must be upgraded together or not at all.

### The version job depends on one repository setting

Opening the version PR requires **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests** to be enabled (`can_approve_pull_request_reviews`). It is enabled today. Turning it off breaks only the last step: the job still creates `changeset-release/main`, runs `pnpm version-packages`, commits, and pushes the branch, and then fails with

```
GitHub Actions is not permitted to create or approve pull requests.
```

A job-level `pull-requests: write` permission does not override the repository setting. If that ever happens, the versioned branch is already pushed, so the version PR can be opened by hand from `changeset-release/main` while the setting is restored.

`default_workflow_permissions` stays `read`, which is correct and should not be widened: each job declares the write scopes it needs, so the default token starts with no more than read access.

### Authentication is npm Trusted Publishing

There is no npm token, and no Actions secret of any kind. The workflow authenticates with OIDC: `id-token: write` lets npm exchange a GitHub-issued id token for a short-lived publishing token. Two consequences shape the workflow:

- **npm is pinned.** `changeset publish` shells out to `pnpm publish`, which packs a tarball and hands the registry call to the npm CLI. Trusted publishing arrived in npm 11.5.0, and Node releases 24.0.0 through 24.4.1 shipped npm older than that, so the job installs a fixed npm rather than inheriting whatever the runner resolves for `node-version: 24`. `scripts/assert-npm-supports-trusted-publishing.mjs` then checks the npm that `pnpm publish` will actually invoke, which is the one next to the running node executable rather than the first `npm` on `PATH`.
- **`registry-url` is deliberately absent** from `actions/setup-node`. It writes an `.npmrc` whose `_authToken` expands to the literal string `${NODE_AUTH_TOKEN}` when no such variable exists. npm reads that as a credential, so a failed OIDC exchange would surface as an opaque `401` instead of a clear `ENEEDAUTH`. With no `.npmrc`, OIDC is the only credential source and its absence fails loudly.

Configure the GitHub `npm` environment with required reviewers. Configure npm trusted publishers for both scoped packages with:

- GitHub owner: `cychien`
- repository: `datafridge`
- workflow filename: `release.yml`
- environment: `npm`

**Do not dispatch the workflow until trusted publishing is configured for both packages.** There is no token to fall back on, so the publish step will simply fail.

## First publication of 1.0.0 (captain, local, one time only)

npm can only accept a trusted-publisher configuration for a package that already exists, so `1.0.0` has to be published by hand. Everything after `1.0.0` goes through the dispatched workflow.

**`1.0.0` published this way carries no provenance attestation.** npm only generates provenance inside GitHub Actions or GitLab CI; anywhere else `libnpmpublish` throws `EUSAGE: Automatic provenance generation not supported for provider: null`. Provenance therefore starts with the first CI-published release, not with `1.0.0`. That is an accepted, one-time consequence of bootstrapping without a token.

`1.0.0` is already on `main`: the version PR landed in [#6](https://github.com/cychien/datafridge/pull/6), so both packages read `1.0.0` and the changeset queue is empty. This precondition is met; confirm it rather than re-create it.

```sh
git checkout main
git pull --ff-only
git status --porcelain   # must be empty
```

Authenticate; you are not currently logged in locally:

```sh
npm login
npm whoami
```

Run the same gates CI would, then publish each package from inside its own directory:

```sh
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test && pnpm release:check

cd packages/core
pnpm publish --no-provenance --access public

cd ../cloudflare
pnpm publish --no-provenance --access public
```

Each part of that command is load-bearing:

- **`pnpm publish`, never `npm publish`.** `@datafridge/cloudflare` declares `"@datafridge/core": "workspace:^"`. pnpm rewrites that to a real semver range while packing; npm does not. Verify it yourself before publishing - `pnpm pack` yields `"@datafridge/core": "^1.0.0"`, whereas `npm pack` leaves the literal `workspace:^`, which no consumer can resolve:

  ```sh
  pnpm -C packages/cloudflare pack --pack-destination /tmp/datafridge-pack
  tar -xzOf /tmp/datafridge-pack/datafridge-cloudflare-1.0.0.tgz package/package.json | grep datafridge/core
  ```

- **`--no-provenance`.** Both packages set `publishConfig.provenance: true`, which is correct for CI and fatal locally. npm ignores a `publishConfig` key that was also given on the command line, so this flag is what turns provenance off; editing the committed `package.json` is not the way to do it.
- **`cd` into each package, not `pnpm -C` or `pnpm --filter`.** `pnpm -C packages/core publish` leaks `packages/core publish` into npm's argv and dies with `EUSAGE`. `pnpm --filter @datafridge/core publish` takes pnpm's recursive path, which silently drops `--no-provenance` and so fails on provenance instead.
- **No `--no-git-checks`.** On a clean `main` pnpm's own guard passes, and leaving it on means pnpm refuses to publish from the wrong branch or a dirty tree.

If your npm account requires 2FA on writes, add `--otp <code>` to each publish command.

Note that `pnpm publish --dry-run` never reaches npm's authentication or provenance code, so a clean dry run proves only that the tarball is right.

`--no-provenance` is in the same position: it can only be fully proven by a real publish. It rests on npm ignoring a `publishConfig` key that also appears on the command line, which is read out of npm's source rather than observed, and no dry run can exercise it. If npm still refuses on provenance - `EUSAGE: Automatic provenance generation not supported for provider: ...` - set `provenance` to `false` in each package's `publishConfig` as an **uncommitted local edit**, publish, then revert it with `git checkout -- packages/*/package.json`. Never commit that edit: `publishConfig.provenance: true` is what the CI path needs.

Afterwards, on npmjs.com, for **each** of `@datafridge/core` and `@datafridge/cloudflare`, open Settings and add a GitHub Actions trusted publisher with the owner, repository, workflow filename, and environment listed above. Only then may the workflow be dispatched.

Tag and release `1.0.0` in git as well, since the local publish does not create the tags the action would.

## Release sequence

1. Merge feature changes and their changeset to `main` after review.
2. Let the workflow open the version PR.
3. Review its versions, changelogs, peer range, and lockfile, then merge it.
4. Obtain captain approval for the exact package versions and npm public names.
5. For `1.0.0` only, follow the local first-publication runbook above and then configure trusted publishers.
6. For every later release, approve the protected `npm` environment and dispatch `release.yml` on `main`.
7. Verify npm provenance (from the first CI-published release onward), package contents, tags, releases, and clean consumer imports.

Do not publish, tag, reserve a name, create a GitHub release, or dispatch the workflow from a feature branch.
