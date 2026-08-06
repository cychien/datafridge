# datafridge - Implementation Plan

> 對應 DESIGN.md draft v1。原則：每個 milestone 交付可跑、有測試、可獨立驗收的東西；測試與實作同 PR，不補課。

## 工具鏈（M0 就定案）

- pnpm workspaces monorepo、TypeScript strict、ESM only
- build: tsup；test: vitest；Cloudflare 測試: `@cloudflare/vitest-pool-workers`（官方 vitest 整合，可在測試中拿真的 KV binding 與 DO instance，並用 `runDurableObjectAlarm` 手動觸發 alarm）
- lint: eslint + prettier；CI: GitHub Actions（lint + typecheck + test 矩陣）
- changesets 管版本與 changelog

## M0 - Scaffold（半天）

- monorepo 骨架、`packages/core` 與 `packages/cloudflare` 空殼、CI 綠燈
- **驗收**：`pnpm test` 在 CI 跑過一個 placeholder test

## M1 - Core engine（3-4 個晚上）

實作順序即依賴順序：

1. `duration.ts` - '5m' 解析；`clock.ts` - 時鐘注入介面（core 內禁用 `Date.now()`，lint rule 擋）
2. types（`QueryDef`、`Envelope`、`ScheduleRow`、`Store`、`RunReport`）
3. `defineQueries` - config-time 驗證（重複 name、timeout >= lease、非法 duration）
4. `memoryStore` - 含 atomicClaim 語意的參考實作
5. planner - due 篩選、過期比例排序、per-source budget
6. `runDue` engine - claim、AbortSignal timeout、寫回、backoff、jitter、RunReport
7. `createReader` / `read()` / SWR 退化模式

### M1 測試（全部用注入的假時鐘，零 sleep、完全確定性）

DESIGN.md 裡走過的每一條時間軸都變成一個測試案例：

| 案例 | 驗證 |
|---|---|
| 冷啟動 | 無 record = 全部到期；首跑帶 jitter |
| budget 擠壓 | posthog 組 3 個到期、預算 2 → 跑 2 個，第 3 個下個 tick 自動接手 |
| 過期比例排序 | 遲到 4m 的 5m query 排在遲到 5m 的 60m query 前面 |
| fixed-delay | 慢 query 完成後 nextRunAt 從完成時間起算，不堆積 |
| stale-if-error | fetch throw → 舊 envelope 保留、failCount++、read() 回 isStale |
| backoff 曲線 | 1m → 2m → 4m → 收斂在 every；成功後歸零 |
| timeout abort | fetch 超時 → AbortSignal 觸發 → 記為失敗 |
| lease 跳過 | 租約未過期時第二個 runDue 靜默跳過 |
| lease 過期重撿 | 執行者「暴斃」（不寫回）→ 租約過期 → 重新 claim |
| zombie 寫回被拒 | version 不符的寫回被丟棄，store 內容不變 |
| 併發 runDue | 兩個 runDue 同時跑（Promise.all）→ 每個 query 恰好 fetch 一次 |
| serialized waiver | driver 宣告 serialized + store 無 atomicClaim → 允許；非 serialized → 建構時 throw |
| read() 契約 | null（首輪未完）、fresh、stale、age 計算 |
| registry reconcile | 新增/刪除/改 every → rows 增刪與 nextRunAt 重算 |
| RunReport | ran / skippedLeased / deferredBudget / failed 分類正確 |

**驗收**：上表全綠 + core 對 `Date.now` 零引用 + memoryStore 通過一份「Store contract 相容性測試套件」（這份套件會被所有 adapter 重用，是 adapter 生態的規格書）。

## M2 - Cloudflare adapter（3-4 個晚上）

1. `d1Store` - full Store（ResultStore + ScheduleStore），claim 用 `UPDATE ... WHERE version = ?` 檢查 changes；schema migration SQL 隨包附上
2. `d1Results` - 上者的 ResultStore 子集（組合 A 的 result plane）
3. `PollerDO`（doAlarms driver）- 內部簿記 SQLite schema、alarm loop（`finally` 設鬧鐘）、`ensureStarted()`、registry reconcile
4. defer = `ctx.waitUntil` 接線

### M2 測試（`@cloudflare/vitest-pool-workers`，真 binding）

- Store contract 相容性套件完整跑在 `d1Store` 上（真 D1 binding），含 CAS claim 的併發案例
- `runDurableObjectAlarm` 手動觸發 alarm：驗證 due queries 被執行、結果落 D1、鬧鐘重設在 min(nextRunAt)
- 鬧鐘鏈韌性：fetcher throw → alarm 不 throw、failCount 記錄、下一個 alarm 仍被設定
- `ensureStarted` 冪等：呼叫兩次不產生雙鏈
- reconcile：改 queries 後簿記 rows 與 D1 envelope 的增刪
- 讀取端：另一個 Worker context 用 `createReader` 直讀 D1，不經過 DO

**驗收**：全綠 + 一個 `examples/cloudflare-basic` 範例 app 在 `wrangler dev` 下手動驗證完整流程（poll 一個假 API → read 端點回 fetchedAt/isStale）。

## M3 - Cron shell + init CLI + 打磨（2 個晚上）

- cron trigger driver shell（`scheduled` handler 一行接線，組合 B：cron + d1Store，CAS 保護併發 tick）
- 安裝 `@datafridge/cloudflare` 後以 `pnpm exec datafridge init cloudflare`（npm：`npx --no-install datafridge init cloudflare`）寫入兩種組合的 wrangler.toml 宣告（migrations、bindings、crons）
- config-time 驗證補完（timeout vs 平台上限、schedule plane resolution 失敗案例）
- **測試**：CLI 對 fixture wrangler.toml 的冪等寫入；cron shell 的 e2e（vitest-pool-workers 可直接呼叫 scheduled handler）；兩個併發 scheduled invocation 對同一 D1 → 每個 query 恰好 fetch 一次

## M4 - Dogfood + 發布（1 個晚上 + 觀察期）

- 用真實 PostHog query 接一個實際 project 跑數天（第一個真使用者）
- README（語意契約放最前面）、API docs、npm publish with provenance
- Dogfood 發現並由 captain 接受一個提前交付的 Wave 2 slice：finite parameterized queries。支援 runtime variants、canonical SHA-256 identity、每個 variant 獨立 schedule/lease/backoff/envelope、增刪 reconcile，以及 base name + params direct read；identity 與 evidence 不含 raw params 或 secrets
- **測試**：deterministic variant identity、canonical collision/非法 params、獨立成功/失敗/lease state、added/removed reconcile、direct read，以及 PollerDO + D1 variant lifecycle
- **驗收**：dogfood 期間 zero 手動介入；RunReport log 裡 lease/backoff 行為與設計一致

## 里程碑依賴

```
M0 → M1（core + contract 測試套件）→ M2（CF adapter 吃 contract 套件）→ M3 → M4
```

M1 的 Store contract 測試套件是槓桿點：之後每個新 adapter（redis/sqlite/d1）的正確性驗收都是「跑同一份套件」，不重寫測試。

## 明確不在本計劃內

- Node timer driver、Redis/SQLite adapters（wave 2）
- 精確配額記帳、無界或 read-time on-demand/custom-range variants、metrics exporter（DESIGN.md roadmap）
