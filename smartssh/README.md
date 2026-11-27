# SmartSSH

以 Tabby 為基礎的 Windows terminal，加上一層「先提案、後執行」的閘門與狀態 bar。
單一 portable exe，免安裝。

> 本文件描述 1.0.238 這個 release。哪些功能已接入 app、哪些只有核心模組，見
> [CHANGELOG.md](CHANGELOG.md) 的「未包含」一節。

## 安裝

1. 由 CI artifact `smartssh-portable` 取得
   `smartssh-1.0.238-portable-x64.exe`（同 `extras/smartssh-buildinfo.json`）。
2. 放到任何你用得順手的資料夾，雙擊執行。沒有 installer、沒有安裝步驟。
3. 首次啟動會在 exe 旁邊建立 `data\`（見下一節）。要搬去另一部機，把 exe 連 `data\` 一齊複製。

exe 未經程式碼簽章，第一次執行會有 SmartScreen 提示，見文末。

## Portable 行為

SmartSSH 的 portable build 由 electron-builder 的 `portable` target 產生，該 target 會把
`PORTABLE_EXECUTABLE_DIR` 設成「exe 所在資料夾」。程式據此決定 userData（設定、log、session）放哪：

| 情況 | userData 位置 | 說明 |
| --- | --- | --- |
| exe 所在資料夾**可寫** | `<exe 資料夾>\data` | 正常情況，資料跟著 exe 走 |
| exe 所在資料夾**唯讀** | `%TEMP%\smartssh-ro` | 唯讀模式，**不會**靜默寫入 `%LOCALAPPDATA%` |
| 沒有 `PORTABLE_EXECUTABLE_DIR` | Electron 預設 userData | dev / 非 portable 執行 |
| 沒有 `PORTABLE_EXECUTABLE_DIR`，但 exe 旁邊已有 `data\` | 該 `data\` | 沿用上游 Tabby 慣例 |

唯讀位置的例子：光碟、被 ACL 鎖住的 USB、公司資料夾加了 Deny ACE。

- 可寫性是用「在 portable 根目錄建立再刪除一個探測檔」判斷，不是 `mkdir data`——
  唯讀資料夾即使擋了寫入，仍可能准許建立子資料夾，用 `mkdir` 判斷會留下一個空的 `data\`。
- 唯讀模式下 console 會印 `[smartssh] portable root is read-only, using <path>`，
  正常模式印 `[smartssh] portable userData -> <path>`。
- 唯讀模式下設定與 session 只存在暫存資料夾，程式關閉後可能被系統清掉；要保留請把 exe 放去可寫位置。

> 以上規則的實作在 `smartssh/app/portablePath.mjs`（配 `app/lib/portable.ts`）。若你用未合併該分支的
> `smartssh` HEAD 自行 build，只有舊行為（exe 旁邊**已存在** `data\` 才使用），見
> [CHANGELOG.md](CHANGELOG.md) 的「合併狀態」。

## Relay 設定

relay 是一個獨立的小型 HTTP 服務（`smartssh/relay/`），負責收 terminal window 的
metadata、發 proposal、記錄 dispatch。app 端用兩個環境變數設定：

| 變數 | 用途 |
| --- | --- |
| `SMARTSSH_RELAY_URL` | relay 的 base URL，例如 `http://127.0.0.1:8787` |
| `RELAY_TOKEN` | Bearer token；relay 端**必須**先設定，否則所有請求一律 `401 token_invalid` |

- 兩個變數都未設定、或 relay 連不上 → bar 顯示 `offline`
  （`smartssh/core/barModel.mjs` 的 9 個 state 之一；原因分 `token` / `network`；
  offline 時只有 `reset_token`、`copy_diag`、`dismiss` 三個控制）。
- relay 端設定方式與完整 wire contract（路由、欄位、錯誤碼）見
  [relay-contract.md](relay-contract.md)。`server.mjs` 只 export `createRelay()`（直接 `node
  server.mjs` 不會起服務），自己起一個 listener 即可：

  ```sh
  RELAY_TOKEN=<token> node --input-type=module -e \
    "import {createRelay} from './smartssh/relay/server.mjs'; createRelay().listen(8787,'127.0.0.1')"
  ```

  放在 loopback 或 TLS 後面，不要直接對公網開放。
- **1.0.238 現況（base HEAD `3a771f6`）**：relay 服務端與契約已完成並有 25 個測試，但該 HEAD 的
  app 內尚未接入 relay client，因此由它 build 的 exe 的 bar 不會連上 relay。若你的 build 已包含
  relay client，這段唔適用；差異見 CHANGELOG 的「未包含」。

## 私隱

- **relay 不保存任何 terminal 文本，也不保存任何 mask 內容。** 它只記錄數字與時間：
  `line_count`、`truncated_lines`、`redacted_segments`、`severity`、`range`、`at`。
  測試會把一段 canary 字串推上去，再斷言 response 內完全沒有它。
- 推送前先在 client 端 redact，規則共 7 條（`smartssh/core/redact.mjs`）：
  `env_key`、`bearer`、`url_cred`、`cli_password`、`known_prefix`（`sk-`、`ghp_`、`AKIA`、
  `xoxb-`、`ssh-rsa …`）、`private_key`（PEM，可跨行）、`password_prompt`（`sudo` 密碼提示）。
  命中就以 `***` 取代。
- 每次只推最近 200 行；超過部分由 relay 丟棄，並在 `received.server_dropped_lines` 回報。
- relay 只記錄 dispatch，**永不執行**任何命令；所有狀態在記憶體，重啟即清空。

## 版本

- 顯示格式為三段：`1.0.238 · sms.<run> · <commit>`（base · build · commit）。
  `sms.<n>` 來自 CI run number，`local.<n>` 來自 `build-local.ps1` 本機 build。
- 來源是 exe 旁邊 `extras\smartssh-buildinfo.json`（CI 產生，內容為
  `{base, build, commit, builtAt}`）。
- 檔案缺失、BOM 異常或任何欄位格式不合 → 顯示 `dev`，不會顯示看起來合理的假版本號。
- `base` 由 `.github/workflows/smartssh-win.yml` 的 `SMARTSSH_VERSION` 決定（本版 `1.0.238`）。

## SmartScreen 提示

exe 未簽章（build 設定 `forceCodeSigning: false`），所以 Windows 首次執行會顯示
「Windows protected your PC」：

1. 按 **More info**。
2. 按 **Run anyway**。

只在你信任 artifact 來源時才這樣做。下載後可自行核對 SHA256，與 CI artifact 頁面上的值比對：

```powershell
Get-FileHash .\smartssh-1.0.238-portable-x64.exe -Algorithm SHA256
```

## 開發

```sh
node smartssh/relay/relay.test.mjs   # relay 契約測試
node smartssh/verify/test-all.mjs    # 全部 SmartSSH 測試
node smartssh/verify/check-docs.mjs  # 文件完整性檢查
```
