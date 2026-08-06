# Release process and package names

English | [繁體中文](./zh-TW/releasing.md)

This repository uses Changesets and a manually dispatched, post-merge GitHub Actions publish job. No release action should run from a feature branch.

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

[`.github/workflows/release.yml`](../.github/workflows/release.yml) has three least-privilege stages:

1. A push to `main` selects Changesets mode.
2. If changesets exist, the version job can create or update a version PR. That PR must be reviewed and merged normally.
3. When versioned packages are on `main`, a captain manually dispatches the workflow. Only that event can enter the `npm` environment and run the publish job.

The publish job checks out `main`, installs with the lockfile, runs lint, typecheck, tests, and package verification, then calls Changesets publish. It uses a GitHub-hosted runner, Node 24 with npm 11.5.1 or newer, `id-token: write`, public `publishConfig`, and provenance. Actions are pinned by commit SHA. The action creates package tags and GitHub releases only after publication.

Configure the GitHub `npm` environment with required reviewers. Configure npm trusted publishers for both scoped packages with:

- GitHub owner: `cychien`
- repository: `datafridge`
- workflow filename: `release.yml`
- environment: `npm`
- allowed action: `npm publish`

Trusted publishing requires an existing npm package. If npm does not permit trusted-publisher setup before the first release, the captain must explicitly approve a one-time bootstrap and provide a short-lived, least-privilege `NPM_TOKEN` through the protected `npm` environment. The same reviewed `release.yml` run must perform the initial publish with provenance. Immediately afterward, remove the token, configure trusted publishing for both packages, and keep future releases OIDC-only. Never place a token in repository configuration, logs, commands, or PR evidence.

## Release sequence

1. Merge feature changes and their changeset to `main` after review.
2. Let the workflow open the version PR for `1.0.0`.
3. Review its versions, changelogs, peer range, and lockfile, then merge it.
4. Obtain captain approval for the exact package versions, npm public names, workflow dispatch, tags, releases, and any bootstrap credential step.
5. Approve the protected `npm` environment and dispatch `release.yml` on `main`.
6. Verify npm provenance, package contents, tags, releases, and clean consumer imports.
7. Remove any bootstrap token and enforce trusted publishing.

Do not publish, tag, reserve a name, create a GitHub release, or dispatch the workflow from a feature branch.
