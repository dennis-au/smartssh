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

## 系統需求

- Windows 10 / 11 **x64**（portable，免安裝；ARM64 未提供）。
- **Microsoft Visual C++ 2015–2022 x64 Redistributable**（即 `vcruntime140.dll` 與 `msvcp140.dll`）
  是必要條件——乾淨的 Windows image（部分 OEM image、精簡版、Server Core、受管企業 image）
  **未必有**。缺了就是「需要 Microsoft Visual C++ 2015–2022 x64 Redistributable」，
  因為 SSH 引擎（原生模組 `russh.win32-x64-msvc.node`）載入失敗（Windows error 126）。
- 缺 runtime 會怎樣：主進程在任何視窗出現**之前**就探測，缺就跳一個可讀的雙語對話框
  （原因、缺少哪個 DLL、官方下載連結、「已安裝，重試」、「結束」），按「結束」時以 exit code 3 離開。
  **不會**再出現「只有 splash、主視窗永遠不出現、乜都冇講」的舊情況。
- 下載（**x64，不是 x86**）：<https://aka.ms/vs/17/release/vc_redist.x64.exe>
  說明頁：<https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist>
- 離線／內網：把 `vc_redist.x64.exe` 放在 exe 同一個資料夾，對話框會多一個「安裝」選項。
  程式只會執行**你放進去**的檔案，永遠不會自己去下載並執行二進位檔。
- 驗收清單同樣會先檢查：缺 runtime 時 `windows-checklist.ps1` 會在任何量測之前以 exit code 3 失敗，
  並印出同一段訊息。
- **出廠 exe 不含任何微軟 binary**（沒有 redist DLL、沒有 installer）；runtime 由微軟自己的 installer
  裝在系統上。為何選「偵測 + 指引」而不是內嵌 installer，理由見
  [docs/vcredist-decision.md](docs/vcredist-decision.md)。

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

## UI metrics

`smartssh/verify/windows-checklist.ps1` 的第 3 段要讀 `<exe 所在資料夾>\data\metrics.json`，
交 `smartssh/core/metrics-check.mjs` 判 PASS/FAIL。這個檔由 app 自己寫，位置不是 cwd：

| 變數 | 用途 |
| --- | --- |
| `SMARTSSH_MEASURE` | 設 `1` 才寫 metrics；其他值（`true`、`0`、空白）一律當關閉 |
| `SMARTSSH_MEASURE_PATH` | 選填。絕對路徑直接用；相對路徑以 **exe 所在資料夾**為根，不是 cwd |

- 沒有 `SMARTSSH_MEASURE_PATH` 時，檔案寫到 `<exe 資料夾>\data\metrics.json`
  （`PORTABLE_EXECUTABLE_DIR` 有設就用它，否則用 exe 自己的資料夾），
  即 checklist 找的同一個位置。
- 檔案在關閉視窗／終端分頁時 flush（`service.stop()`），內容是三個 case：
  `683x512`、`911x512`、`900-high-split`。只有與當前視窗尺寸相差 ≤2px 且取得即時讀數的 case
  才標為 `measured:true`，並記錄 `window.devicePixelRatio`。其餘標為 `declared:true`，
  幾何與 DPR 來自 `CASE_SPEC`，不計入實測數。判檔最後一行 `live measurements: N/3` 顯示實測覆蓋率。
- build 身份由 exe 旁邊的 `resources\extras\smartssh-buildinfo.json` 讀（依序再試
  `<exe>\data\`、`<exe>\extras\`，最後才是開發用的 cwd 相對路徑）；同一個檔就是 checklist 傳給
  `--buildinfo` 的那個。`build.sha256` 必須是 exe 的 64 位十六進位 SHA-256。若 buildinfo 未提供，
  app 會讀 `PORTABLE_EXECUTABLE_FILE` 指向的外層 portable exe 計算，而非解壓後的副本；
  非 portable 則用 `process.execPath`。無法確認身份就不寫檔。checklist 用 `--exe-sha` 傳入
  它對受測 exe 算出的雜湊，比對是否同一個檔。
- `trustVisible.armed` 取自當時的 token 狀態。未 armed 的 run 記錄 `armed:false` 及非空的
  `gateReason`，不會單因未 armed 而 FAIL；判檔會檢查旗標與 `trust` 是否一致。
- 自行判檔：

  ```sh
  node smartssh/core/metrics-check.mjs --metrics <exe>\data\metrics.json --buildinfo <exe>\resources\extras\smartssh-buildinfo.json --exe-sha <sha256>
  ```

  要 `0 skipped`，請同時提供 buildinfo 與受測 exe 的雜湊；也可用 `--exe <path>` 直接算雜湊。
- 路徑規則的實作在 `smartssh/app/metricsPath.mjs`（`resolveMetricsPath()` / `isMeasureEnabled()`）。

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

要在**有** runtime 的機上證明「缺 runtime 的對話框」會出現（唔需要改 System32 任何檔案）：
`set SMARTSSH_SIMULATE_MISSING_VCRUNTIME=1` 再啟動 exe。這個開關只會令程式拒絕啟動（強制判定為
缺失），永遠唔會令檢查通過，所以唔可以用嚟造假；對話框訊息第一行會寫明係模擬。同理，驗收清單用
`-RuntimeDirs <空資料夾>` 做同樣的隔離模擬。
