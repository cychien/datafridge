# Rate limiting

[English](../rate-limiting.md) | 繁體中文

datafridge 按 `source`（query 定義上的 `source` 欄位，預設 `'default'`）把 queries 分組，並限制每個 source 被打的力道。Wave 1 提供簡單、無狀態的版本；精確記帳的版本在 roadmap 上，只給真正需要它的少數場景。

## v1：per-tick budget + jitter

```ts
createPoller({
  driver: cronDriver(ctx),
  store: d1(env.DB),
  queries,
  sources: { posthog: { maxPerTick: 2 } },
})
```

每個 `runDue` tick 把到期的 queries 按 source 分組，每組最多跑 `maxPerTick` 個。展開的 parameter variants 會依 definition 的 source，以獨立 query 參與 budget。被預算擠掉的 queries 保持到期，下個 tick 自然接手 - 而且因為優先級是過期比例 `(now - nextRunAt) / every`，被擠掉的 query 每等一個 tick 優先級就升高，不會有東西餓死。

兩個性質讓它成為正確的 v1：

- **無狀態。** 預算不需要 counter、不需要共享狀態，所以在分散式併發執行者（含多實例 cron）之間天然安全。
- **排程刷新的上限。** 不管你註冊了多少 query，tick 呼叫上游的次數永遠不會超過 `maxPerTick × tick 頻率`。

這個預算涵蓋的是排程工作。讀取時發現什麼都沒有會當場去抓，那次抓取由 lease 保證同一個 key 只有一次 - 一百個讀者讀同一個冷 key 只產生一次呼叫 - 但它目前還沒有計入 source 的預算，所以一整批**不同的**冷 key 同時進來時，可能超過上面那個上限。把每一個上游呼叫都納入同一份 per-source 計數，就是下面的 v2 工作。

Jitter 是另一半。首次註冊時，每個 query 的 `nextRunAt` 會加隨機偏移，讓整數倍週期的 queries（`5m`、`10m`、`1h`）永遠不會固定對齊同一個 tick、集體衝撞同一個 source 的預算。預算是保險絲，jitter 讓保險絲平常不用燒。

## v2（roadmap）：精確 window 記帳

尚未實作。計劃是：per-source window counter 放進 schedule plane、以 CAS 更新，提供跨所有執行者共享的精確「每 window N 次呼叫」記帳。

只有以下**三個條件同時成立**時才需要它：

1. 多個程式共用同一份供應商硬配額，
2. 配額無法拆成不同的 API key，而且
3. 你真的會把額度用到接近上限。

任一條件不成立，v1 的預算就已經給你安全的上限 - 而如果能拆 API key，先拆。那永遠比分散式記帳簡單。
