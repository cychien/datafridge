# Release 流程與 package 名稱

[English](../releasing.md) | 繁體中文

本 repository 使用 Changesets，以及手動 dispatch 的 post-merge GitHub Actions publish job，並以 npm Trusted Publishing 認證。沒有 npm token。唯一的例外是 `1.0.0` 的首次發布，由 captain 在本機執行，因為 npm 無法為尚不存在的 package 註冊 trusted publisher。任何 release action 都不得從 feature branch 執行。

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

Publish job 會 checkout `main`、pin npm、依 lockfile 安裝、在還有任何 pending changeset 時拒絕繼續、執行 lint、typecheck、tests 與 package verification，再呼叫 Changesets publish。它使用 GitHub-hosted runner、Node 24、`id-token: write`、public `publishConfig` 與 provenance。Actions 都 pin 到 commit SHA，並在旁註明對應的 tag。只有 publication 成功後，action 才建立 package tags 與 GitHub releases。

`changesets/action` pin 在 `v1`，也就是支援本 repository 所安裝的 `@changesets/cli` v2 的那條線。`v2` action 線要求 `@changesets/cli` v3，對著 v2 CLI 會立刻失敗，因此兩者必須一起升級，否則都不要動。

### 認證方式是 npm Trusted Publishing

沒有 npm token，也沒有任何 Actions secret。Workflow 以 OIDC 認證：`id-token: write` 讓 npm 把 GitHub 發出的 id token 換成短期 publishing token。這帶來兩個影響 workflow 結構的後果：

- **npm 版本被 pin 住。** `changeset publish` 會呼叫 `pnpm publish`，後者自行打包 tarball，再把 registry 呼叫交給 npm CLI。Trusted publishing 從 npm 11.5.0 才有，而 Node 24.0.0 到 24.4.1 這幾個版本內附的 npm 都比它舊，因此 job 會安裝固定版本的 npm，而不是沿用 `node-version: 24` 解析到的任何版本。`scripts/assert-npm-supports-trusted-publishing.mjs` 接著檢查 `pnpm publish` 實際會呼叫的那個 npm，也就是 node 執行檔旁邊那一個，而不是 `PATH` 上第一個 `npm`。
- **`actions/setup-node` 刻意不設 `registry-url`。** 它會寫出一份 `.npmrc`，當環境中沒有對應變數時，其中的 `_authToken` 會展開成字面字串 `${NODE_AUTH_TOKEN}`。npm 會把它當成 credential，於是 OIDC 交換失敗時只會冒出難解的 `401`，而不是清楚的 `ENEEDAUTH`。沒有那份 `.npmrc`，OIDC 就是唯一的 credential 來源，缺少時會明確失敗。

GitHub `npm` environment 必須設定 required reviewers。兩個 scoped packages 的 npm trusted publisher 設定為：

- GitHub owner：`cychien`
- repository：`datafridge`
- workflow filename：`release.yml`
- environment：`npm`

**在兩個 packages 都設定好 trusted publishing 之前，不要 dispatch workflow。** 沒有 token 可以退回，publish step 只會失敗。

## 1.0.0 首次發布（captain、本機、僅此一次）

npm 只能為已經存在的 package 設定 trusted publisher，因此 `1.0.0` 必須手動發布。`1.0.0` 之後的每次 release 都走 dispatch 的 workflow。

**以這種方式發布的 `1.0.0` 不會有 provenance attestation。** npm 只在 GitHub Actions 或 GitLab CI 內產生 provenance；在其他環境 `libnpmpublish` 會丟出 `EUSAGE: Automatic provenance generation not supported for provider: null`。因此 provenance 是從第一個由 CI 發布的 release 開始，而不是從 `1.0.0` 開始。這是不用 token 做 bootstrap 所接受的一次性後果。

目前 package versions 是 `0.0.0`。在執行以下任何步驟前，`1.0.0` 必須已透過 merge 的 version PR 進入 `main`。

```sh
git checkout main
git pull --ff-only
git status --porcelain   # 必須是空的
```

先認證，你目前在本機並未登入：

```sh
npm login
npm whoami
```

跑一遍與 CI 相同的 gates，然後在每個 package 自己的目錄內發布：

```sh
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test && pnpm release:check

cd packages/core
pnpm publish --no-provenance --access public

cd ../cloudflare
pnpm publish --no-provenance --access public
```

這個指令的每一部分都有作用：

- **用 `pnpm publish`，絕不用 `npm publish`。** `@datafridge/cloudflare` 宣告 `"@datafridge/core": "workspace:^"`。pnpm 在打包時會把它改寫成真正的 semver range，npm 不會。發布前請自行驗證 - `pnpm pack` 得到 `"@datafridge/core": "^1.0.0"`，而 `npm pack` 會留下字面的 `workspace:^`，任何 consumer 都無法解析：

  ```sh
  pnpm -C packages/cloudflare pack --pack-destination /tmp/datafridge-pack
  tar -xzOf /tmp/datafridge-pack/datafridge-cloudflare-1.0.0.tgz package/package.json | grep datafridge/core
  ```

- **`--no-provenance`。** 兩個 packages 都設了 `publishConfig.provenance: true`，這對 CI 是正確的，在本機則是致命的。npm 會忽略同時出現在 command line 上的 `publishConfig` key，所以是這個 flag 關掉 provenance；不要改動已 commit 的 `package.json`。
- **`cd` 進各個 package，不要用 `pnpm -C` 或 `pnpm --filter`。** `pnpm -C packages/core publish` 會把 `packages/core publish` 漏進 npm 的 argv 並以 `EUSAGE` 失敗。`pnpm --filter @datafridge/core publish` 走的是 pnpm 的 recursive 路徑，會靜默丟掉 `--no-provenance`，結果在 provenance 上失敗。
- **不要加 `--no-git-checks`。** 在乾淨的 `main` 上 pnpm 自己的檢查會通過，保留它才能讓 pnpm 拒絕從錯誤的 branch 或有未提交變更的工作樹發布。

如果你的 npm 帳號在寫入時要求 2FA，請在每個 publish 指令加上 `--otp <code>`。

注意 `pnpm publish --dry-run` 不會走到 npm 的認證與 provenance 程式碼，因此 dry run 乾淨只能證明 tarball 正確。

完成後在 npmjs.com 上，替 `@datafridge/core` 與 `@datafridge/cloudflare` **各自**進入 Settings，以上面列出的 owner、repository、workflow filename 與 environment 新增 GitHub Actions trusted publisher。只有在這之後才可以 dispatch workflow。

同時也要在 git 上為 `1.0.0` 建立 tag 與 release，因為本機發布不會產生 action 原本會建立的那些 tags。

## Release sequence

1. Feature changes 與 changeset 通過 review 後 merge 到 `main`。
2. 讓 workflow 建立 version PR。
3. Review versions、changelogs、peer range 與 lockfile，再 merge。
4. 取得 captain 對精確 package versions 與 npm public names 的批准。
5. 僅 `1.0.0` 依照上面的本機首次發布 runbook 執行，然後設定 trusted publishers。
6. 之後每次 release 都批准受保護的 `npm` environment，並在 `main` dispatch `release.yml`。
7. 驗證 npm provenance（從第一個由 CI 發布的 release 起）、package contents、tags、releases 與 clean consumer imports。

不得從 feature branch publish、tag、reserve name、建立 GitHub release 或 dispatch workflow。
