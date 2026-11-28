# VC++ 2015–2022 x64 runtime：為何選「偵測 + 指引」而非「自帶 installer」

狀態：已決定（1.0.243 起的行為）。實作：`smartssh/app/vcredist.mjs`、`app/lib/vcredistPreflight.ts`、
`smartssh/verify/windows-checklist.ps1` 第 0 段。

## 事實（量測所得，非推測）

VM 210（Windows 11 Enterprise Eval 24H2, 26100.1742）全新安裝後直接跑
`smartssh-1.0.242-portable-x64.exe`：

| 觀察 | 值 |
| --- | --- |
| 視窗 | 只有 splash，主視窗永遠不出現 |
| 主進程 | 沒有 crash log、沒有 dialog |
| 根因 | `russh.win32-x64-msvc.node` `dlopen` 失敗，Windows **error 126** |
| 連鎖 | renderer 拋 `NullInjectorError: No provider for HostAppService`，safe-mode 重試亦失敗 |
| 裝 `vc_redist.x64.exe` 後 | 六步驗收 PASS |

VC++ 2015–2022 x64 runtime 在乾淨 Windows 上**不保證存在**（OEM image、精簡版、Server Core、
部分受管企業 image 都會缺），所以這是產品缺陷，不是驗收機的問題。

## 選項

| 選項 | 內容 | 成本 | 風險 |
| --- | --- | --- | --- |
| A 偵測 + 指引（**採用**） | 啟動時探測 `vcruntime140.dll` / `msvcp140.dll`，缺就跳雙語對話框，附官方下載連結與「已安裝，重試」；支援使用者自行放 installer 在 exe 旁 | 約 8 KB code，0 MB 出廠體積 | 使用者要自己去下載（一次） |
| B 內嵌 installer（electron-builder `extraFiles`） | exe 自帶 25 MB `vc_redist.x64.exe`，對話框提供「安裝」 | exe 121 MB → 146 MB（+20%） | portable target 每次啟動都要解壓多 25 MB；要背微軟授權聲明 |
| C 靜默自動下載並執行 | 啟動時從 aka.ms 下載 25 MB 並執行 | 0 MB 出廠 | 未簽章的 portable app 自行下載並執行二進位檔：安全上不可接受 |
| D App-local 部署 CRT DLL | 把 `Microsoft.VC143.CRT` 的 DLL 放 exe 旁（微軟允許） | 約 1.5 MB | 要從 build runner 的 VS 安裝目錄取檔；路徑不存在時 electron-builder 會靜默跳過（run 19 就是這樣出廠零 plugin）；仍需授權聲明與 CI 依賴 |

## 決定

**選項 A。** 三個理由，按重要性：

1. **真正的缺陷是「靜默」，不是「缺 DLL」。** 使用者看到的是「一裝即開唔到、只見到 splash，乜都冇講」。
   A 把這個缺陷完全消除：一句可讀的原因、一個下載連結、一個重試鍵，而且**在任何視窗出現之前**就講清楚。
2. **B/C/D 都避不開 UAC。** `vc_redist` 一定要提權安裝。既然使用者無論如何都要按一次 UAC，
   多背 25 MB（B）或一條「未簽章程式自行下載並執行二進位」的路徑（C）換不到少一步操作。
3. **邊界要求「唔准靜靜 bundle 微軟 binary」。** B/D 兩者都要在 LICENSE/README 交代並保留授權聲明，
   而它們換來的好處（少一次瀏覽器下載）遠小於多出來的體積、CI 依賴與授權維護成本。
   A 出廠不含任何微軟 binary，這條邊界自然滿足。

同時保留 B 的實用部分：**如果**使用者自己把 `vc_redist.x64.exe` 放在 exe 旁邊（離線機、內網），
對話框會多一個「安裝」選項。程式只執行使用者提供的檔案，永不自行下載。

## 具體行為（可驗證）

| 場景 | 行為 |
| --- | --- |
| 有 runtime | 完全沒有額外步驟；preflight 只做兩次 `existsSync` |
| 缺 runtime，在線上 | 對話框：原因 + 官方下載連結（開啟瀏覽器）+「已安裝，重試」+「結束」 |
| 缺 runtime，exe 旁有 installer | 對話框多一個「安裝」；跑 `/install /passive /norestart`，完成後重新探測 |
| 使用者按「結束」/ 關閉對話框 | `app.exit(3)`，**不會**再出現「卡 splash」 |
| 非 Windows（dev） | preflight 是 no-op（`applicable=false`） |
| 驗收清單 | 第 0 段先探測；缺失 → `exit 3`，訊息含「需要 Microsoft Visual C++ 2015–2022 x64 Redistributable」與下載 URL，且**任何量測都未執行** |

程式不會在缺 runtime 的情況下硬著頭皮啟動：那樣只會重現原本的 splash 死局，並讓 log 看起來像別的錯。

## 驗證（VM 210 實機）

| 檢查 | 怎麼做 | 結果 |
| --- | --- | --- |
| 清單：缺 runtime | `windows-checklist.ps1 -Exe <exe> -ExpectedSha <sha> -RuntimeDirs <空資料夾>` | **exit 3**，訊息含 runtime 名稱與下載 URL，`sha256` / size / 啟動測試等量測**完全冇執行** |
| 清單：有 runtime | 同上，`-RuntimeDirs <放住兩個 DLL 的資料夾>` | preflight `PASS vc++-runtime`，之後照常走到 exe 檢查（該次故意指向不存在的 exe，所以 exit 1） |
| 清單：真機照跑 | `-Exe smartssh-1.0.240-portable-x64.exe -ExpectedSha 6608…20D3`（冇 override） | preflight 由 `C:\Windows\System32` 判定 PASS，其餘 `PASS`，`ALL CHECKS PASSED`，exit 0 |
| App：缺 runtime | Electron 43 main bundle + `SMARTSSH_SIMULATE_MISSING_VCRUNTIME=1` | 只建立一個 `#32770` 對話框，標題「Smart SSH · 需要 Microsoft Visual C++ 2015–2022 x64 Redistributable」，**冇主視窗**；關閉後**exit code 3** |
| App：對照組 | 同上但唔設該變數 | 冇出現 runtime 對話框，出現主視窗（`Chrome_WidgetWin_1` / `Tabby`） |

用模擬開關而唔係改 System32 的 DLL：刪／改名系統 DLL 會令同一部機的 sshd、node 一齊壞，而且驗證唔需要
真刪。開關只會**強制失敗**，不可能令檢查通過。

## 之後若要改選 B/D

先決條件：CI 必須有一個「檔案不存在就 build 失敗」的 gate（`extraFiles` 缺檔是靜默的），
LICENSE/README 要有微軟授權聲明，且要重跑一次 VM 210 的「乾淨 image」驗收。
在這些條件成立之前，A 是成本最低而可驗證的選擇。
