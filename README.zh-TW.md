<p align="center">
  <img src="./assets/logo.png" alt="datafridge" width="120" height="120" />
</p>

<h1 align="center">datafridge</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@datafridge/core"
    ><img
      alt="@datafridge/core on npm"
      src="https://img.shields.io/npm/v/%40datafridge%2Fcore?style=flat-square&label=%40datafridge%2Fcore"
  /></a>
  <a href="https://www.npmjs.com/package/@datafridge/cloudflare"
    ><img
      alt="@datafridge/cloudflare on npm"
      src="https://img.shields.io/npm/v/%40datafridge%2Fcloudflare?style=flat-square&label=%40datafridge%2Fcloudflare"
  /></a>
  <a href="https://github.com/cychien/datafridge/actions/workflows/ci.yml"
    ><img
      alt="CI"
      src="https://img.shields.io/github/actions/workflow/status/cychien/datafridge/ci.yml?branch=main&style=flat-square&label=ci"
  /></a>
</p>

<h3 align="center">資料隨時拿取，穩定可靠</h3>

<p align="center"><a href="./README.md">English</a> · <strong>繁體中文</strong></p>

當我們的系統依賴第三方資料時，很容易因為第三方來源不穩，使得我們系統看起來不可靠。

這些不穩包括回應慢、資料時有時無、使用量一大或呼叫太頻繁就撞上 rate limit 等。

datafridge 幫你處理這件事。你只需要註冊一次 query，設定 scheduler、store，以及抓取頻率和 rate limit 這類 metadata，背景的 scheduler 就會定期把最新的第三方資料穩固的寫進你的資料庫中。

整個 library 就是一個承諾：**你的 app 要資料的時候，永遠拿得到。** 不一定是最新的 - 但永遠有，而且在上游允許的範圍內盡可能新。

```
   scheduler tick（Durable Object alarm 或 cron）
        │
        ▼
   ┌──────────────┐   fetch   ┌──────────────┐
   │ your fetcher │ ────────► │ upstream API │   慢 · 限流 · 不穩
   └──────┬───────┘           └──────────────┘
          │ { data, fetchedAt }        失敗時：保留最後一筆成功值、
          ▼                            記錄錯誤、以 backoff 重試
   ┌─────────────────────────────────────────────┐
   │ your store                                  │
   └──────┬──────────────────────────────────────┘
          │ read() - 一次本地查詢
          ▼
   { data, fetchedAt, isStale, age }
```

`@datafridge/core` 是引擎：純邏輯，零 runtime 依賴。`@datafridge/cloudflare` 是 adapter package，讓它能使用 Cloudflare infra 例如 Durable Object alarms、Cron Triggers 或 D1。

## 使用場景

datafridge 適合資料可以短暫過期，但讀取必須穩定快速的場景：

- **Dashboard 與報表**：定期抓取 analytics、廣告或營運數據，不讓每位使用者都等待第三方 API。
- **外部資料同步**：把 CMS、公開資料、活動資訊或 catalog 保存在自己的資料庫，避免上游故障拖垮產品。
- **昂貴的聚合查詢**：在背景預先計算跨服務或大範圍資料，request 只讀已完成的結果。
- **共用 API 額度**：讓多個 Worker、scheduler 與 request 共用 rate limit 和 concurrency ceiling，不會一起打爆上游。
- **故障時持續服務**：上游 timeout、限流或暫時離線時，繼續回傳 last-known-good data，並在背景 backoff 重試。

它不適合付款確認、庫存扣減、權限判斷等必須取得即時真實狀態的交易流程。

## Quick start

以下以 Cloudflare Durable Object (`FridgeDO`) 作 scheduler，和 Cloudflare D1 作 store 示範。環境需 Node.js 20 以上。

```sh
npm install @datafridge/core @datafridge/cloudflare
npx --no-install datafridge init --scheduler durable-object --store d1
npx wrangler d1 create datafridge
```

依 CLI 提示把 D1 的 `database_id` 填進 Wrangler 設定，接著設定 poller 與 fetcher：

```ts
import { createReader, defineQueries } from '@datafridge/core'
import { d1, ensureStarted, FridgeDO } from '@datafridge/cloudflare'

interface Env {
  DB: D1Database
  POLLER: DurableObjectNamespace<Poller>
}

const queries = defineQueries([
  {
    name: 'weekly-summary',
    every: '10m',
    fetch: async ({ signal }) => {
      const response = await fetch('https://api.example.com/weekly-summary', { signal })
      if (!response.ok) throw new Error(`upstream status ${response.status}`)
      return response.json()
    },
  },
])

export class Poller extends FridgeDO<Env> {
  queries = queries

  store(env: Env) {
    return d1(env.DB)
  }
}

export default {
  async fetch(_request: Request, env: Env) {
    await ensureStarted(env.POLLER) // 以 Durable Object 作為 scheduler 才需要，用來觸發第一次 polling
    const reader = createReader({ store: d1(env.DB), queries })
    return Response.json(await reader.read('weekly-summary'))
  },
}
```

第一次讀取會嘗試去拿新鮮資料；一旦有資料，後續讀取只查 D1。完整範例見 [`examples/cloudflare-basic`](./examples/cloudflare-basic)；Cron Triggers、secrets 與 Wrangler 設定見 [Cloudflare 設定](./docs/zh-TW/cloudflare.md)。

## 文件

- [API reference](./docs/zh-TW/api.md)
- [Cloudflare 設定](./docs/zh-TW/cloudflare.md)
- [可執行的 Cloudflare 範例](./examples/cloudflare-basic)

## License

[MIT](./LICENSE)
