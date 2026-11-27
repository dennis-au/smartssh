# Changelog

版本號 = SmartSSH base version（`.github/workflows/smartssh-win.yml` 的 `SMARTSSH_VERSION`）。
顯示用版本另加 build 與 commit，格式見 [README.md](README.md#版本)。

## [1.0.238] — 2026-11-27

### 提案閘門與 bar

- Gate 五個值 `clean` / `prompt_dirty` / `settling` / `alt_screen` / `continuation`，
  純函式、零 xterm 依賴 — `smartssh/core/gate.mjs`
- Settler：feed 後要見到輸出、見到 prompt 行，再用 150 ms 靜默窗決定 — `smartssh/core/settle.mjs`
- Gate input 狀態機（typed input、selection、scrolled、continuation 等阻擋原因）— `smartssh/core/gateInput.mjs`
- Bar model：九個 state `proposed` / `counting` / `settling` / `executing` / `exited` /
  `rejected` / `aborted` / `expired` / `offline`，每個 state 限定可出現的控制項 — `smartssh/core/barModel.mjs`
- Tail hint 判定（只認 shell 自己畫的 hint cell）— `smartssh/core/tailhint.mjs`
- 提案展開預覽 — `smartssh/core/preview.mjs`

### Redaction 與推送

- 七條去敏規則 `env_key` / `bearer` / `url_cred` / `cli_password` / `known_prefix` /
  `private_key` / `password_prompt`，mask 用 `***`，處理不可見字元、mask 不重疊 —
  `smartssh/core/redact.mjs`
- 獨立 audit 覆核 mask 覆蓋 — `smartssh/core/audit.mjs`
- Push payload：不帶原始行，severity 由 mask 結果推導 — `smartssh/core/pushPayload.mjs`

### Relay v2

- 路由、Bearer 認證（timing-safe，401 `token_invalid`）、200 行上限與 truncation 計數 —
  `smartssh/relay/server.mjs`、`smartssh/relay/state.mjs`、`smartssh/relay/response.mjs`
- 完整 wire contract 文件 — `smartssh/relay-contract.md`
- dev-only fault injection（`RELAY_DEV=1`）— `smartssh/relay/devFault.mjs`

### Metrics

- Metrics schema 1：三個 case、九個 bar state、collapsed 必須 height 0 且仍掛載 —
  `smartssh/core/metrics.mjs`
- 測量結果寫入 case 檔 — `smartssh/core/metricsWriter.mjs`
- 檢查器 — `smartssh/core/metrics-check.mjs`

### 版本與診斷

- Buildinfo 解析：strip BOM、base/build/commit 嚴格驗證、不合格顯示 `dev` —
  `smartssh/core/buildinfo.mjs`
- 診斷包（copy_diag 用）— `smartssh/core/diagnostics.mjs`

### Portable 與產品身份

- Portable userData 重定向：可寫 → `<exe>\data`；唯讀 → `%TEMP%\smartssh-ro`；
  永不靜默寫 `%LOCALAPPDATA%`；用探測檔而非 `mkdir` 判斷可寫性 —
  `smartssh/app/portablePath.mjs`、`app/lib/portable.ts`
- 產品身份：productName `Smart SSH`、appId `com.smartssh.app`、
  artifactName `smartssh-<version>-portable-<arch>.exe` — `scripts/build-smartssh.mjs`

### 驗證

- 單一測試入口（自動探索 16 個 test 檔）— `smartssh/verify/test-all.mjs`
- 產品身份靜態檢查 — `smartssh/verify/check-identity.mjs`
- 文件完整性檢查 — `smartssh/verify/check-docs.mjs`
- Windows 驗收清單（含唯讀資料夾與 SmartScreen 項）— `smartssh/verify/windows-checklist.ps1`
- 本機 build 腳本 — `smartssh/verify/build-local.ps1`

## 合併狀態（發佈前必讀）

此版文件描述的是 1.0.238 的完整意圖；下列項目在各自分支完成並已驗證，但**尚未合併入
`smartssh`**。由 `smartssh` HEAD 直接 build 出來的 exe **不含**它們：

| 項目 | 來源分支 | 影響 |
| --- | --- | --- |
| Portable 重定向（`smartssh/app/portablePath.mjs`、`app/lib/portable.ts`） | `wt/t_6cf5f28f`（d6b0620） | 未合併時只有舊行為：exe 旁邊**已存在** `data\` 才使用，唯讀位置會落回 `%APPDATA%` |
| 產品身份覆寫（`scripts/build-smartssh.mjs`） | `wt/t_6cf5f28f`（d6b0620） | 未合併時 productName 仍是 Tabby，artifact 仍是 `tabby-…` |
| 單一測試入口（`smartssh/verify/test-all.mjs`）、身份檢查（`check-identity.mjs`） | `wt/t_adbc0c00`（78aff41）、`wt/t_6cf5f28f` | 未合併時 CI 沒有一鍵全跑與身份檢查 |

## 未包含（base HEAD `3a771f6` 上明確沒有）

以下是文件與卡片常被誤讀成「已做」的項目，在 `3a771f6` 這個 base HEAD 上**未**落地，故不列為功能。
relay client 仍在另一條工作線上，落地後本節應同步刪除：

- **App 內 relay client**：`SMARTSSH_RELAY_URL` 在整個 repo 沒有任何消費端；
  relay 只有服務端。因此 bar 的 `offline` state 目前只存在於 model，不會由網絡狀況驅動。
- **Proposal producer**：app 內沒有把提案寫入 `smartsshProposal` 的呼叫端。
- **Bar UI 接線**：`app/` 內沒有任何檔案引用 `barModel`。
- **Relay 端執行**：relay 只記錄 dispatch，永不執行命令（這是設計，不是缺漏）。
