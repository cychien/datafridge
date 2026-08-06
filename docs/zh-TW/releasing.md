# Release 流程與 package 名稱

[English](../releasing.md) | 繁體中文

本 repository 使用 Changesets，以及手動 dispatch 的 post-merge GitHub Actions publish job。任何 release action 都不得從 feature branch 執行。

## Package 策略

可安裝的 public package graph 只有：

| Package | 預計首次 release | 內容 |
|---|---:|---|
| `@datafridge/core` | `1.0.0` | Engine、types、memory store、parameterized identity、deterministic utilities 與 contract tests |
| `@datafridge/cloudflare` | `1.0.0` | D1 stores、Durable Object alarms、Cron Trigger shell、migration 與 init CLI |

`@datafridge/cloudflare` 把 `@datafridge/core` 宣告為 peer dependency。Changesets 會在 packed artifact 中把 workspace range 轉成 public semver range。

Unscoped names `datafridge` 與 `data-fridge` 只代表品牌保留意圖。它們不是 alias、meta-package 或 package graph 成員。npm 沒有不建立 package 的 name-reservation operation，因此本專案不會為了佔名發布空白或 placeholder package。未來任何 unscoped publication 都必須具備真實 user-facing semantics，並通過獨立 review 與決策。使用者只應安裝 `@datafridge/core` 與 `@datafridge/cloudflare`。

## Local release checks

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm release:check
```

`release:check` 會驗證 Changesets release plan、build 兩個 packages、各 pack 兩次並要求 byte-identical archives、檢查 declarations、migration、CLI、licenses、READMEs 與 subpath exports、拒絕 source/test directories、把兩個 tarball 安裝到乾淨的 temporary npm consumer、匯入 core 與 Cloudflare subpaths，並執行 packaged CLI。

不發布的 tarball inspection：

```sh
pnpm -C packages/core pack --pack-destination /tmp/datafridge-pack
pnpm -C packages/cloudflare pack --pack-destination /tmp/datafridge-pack
shasum -a 256 /tmp/datafridge-pack/*.tgz
```

Tarball 或 release evidence 絕不能包含 credential、private analytics 或 private consumer wiring。

## Automation

[`.github/workflows/release.yml`](../../.github/workflows/release.yml) 有兩個 least-privilege jobs，各自以觸發 event 作為 gate：

1. `version` 只在 push 到 `main` 時執行。有 pending changesets 時建立或更新 version PR，該 PR 必須經過一般 review 與 merge；沒有時則以 no-op 成功結束。此 job 不傳入 publish script，因此無法 publish。
2. `publish` 只在針對 `main` 的 `workflow_dispatch` 時執行，由 captain 在 versioned packages 進入 `main` 後手動觸發。只有此 event 能進入 `npm` environment。

Publish job 會 checkout `main`、依 lockfile 安裝、在還有任何 pending changeset 時拒絕繼續、執行 lint、typecheck、tests 與 package verification，再呼叫 Changesets publish。它使用 GitHub-hosted runner、Node 24 與 npm 11.5.1 以上版本、`id-token: write`、public `publishConfig` 與 provenance。Actions 都 pin 到 commit SHA，並在旁註明對應的 tag。只有 publication 成功後，action 才建立 package tags 與 GitHub releases。

`changesets/action` pin 在 `v1`，也就是支援本 repository 所安裝的 `@changesets/cli` v2 的那條線。`v2` action 線要求 `@changesets/cli` v3，對著 v2 CLI 會立刻失敗，因此兩者必須一起升級，否則都不要動。

GitHub `npm` environment 必須設定 required reviewers。兩個 scoped packages 的 npm trusted publisher 設定為：

- GitHub owner：`cychien`
- repository：`datafridge`
- workflow filename：`release.yml`
- environment：`npm`
- allowed action：`npm publish`

Trusted publishing 需要既有 npm package。如果 npm 不允許在首次 release 前設定 trusted publisher，captain 必須明確批准一次性 bootstrap，並透過受保護的 `npm` environment 提供 short-lived、least-privilege `NPM_TOKEN`。Initial publish 必須由同一個 reviewed `release.yml` run 執行並附帶 provenance。完成後立即移除 token、替兩個 packages 設定 trusted publishing，後續 release 只使用 OIDC。Token 絕不能出現在 repository config、log、command 或 PR evidence。

## Release sequence

1. Feature changes 與 changeset 通過 review 後 merge 到 `main`。
2. 讓 workflow 建立 `1.0.0` version PR。
3. Review versions、changelogs、peer range 與 lockfile，再 merge。
4. 取得 captain 對精確 package versions、npm public names、workflow dispatch、tags、releases，以及任何 bootstrap credential step 的批准。
5. 批准受保護的 `npm` environment，並在 `main` dispatch `release.yml`。
6. 驗證 npm provenance、package contents、tags、releases 與 clean consumer imports。
7. 移除任何 bootstrap token，並強制 trusted publishing。

不得從 feature branch publish、tag、reserve name、建立 GitHub release 或 dispatch workflow。
