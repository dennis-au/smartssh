# 受管端點實測：未簽名 Smart SSH exe 於 AppLocker／WDAC／SAC 下的行為（VM 210）

- 測試日期：2026-11-28 17:49–18:59 HKT
- 測試機：VM 210 `win-accept`（Proxmox，192.168.0.32）
- 作業系統：Microsoft Windows 11 Enterprise Evaluation，10.0.26100.1742（24H2）
- 網域：WORKGROUP，`PartOfDomain=False`（未 join 任何 domain）
- 受測檔案：`C:\work\accept247\smartssh-1.0.247-portable-x64.exe`
  - sha256（flat file）：`44D3CB3364C8E8ACE03CA23CD3E655CA7E3225510AE7845384AEABE6D33FDCC9`
  - `Get-AuthenticodeSignature` = **NotSigned**（`SignerCertificate.Subject` 空）
  - AppLocker 影像 hash（Authenticode/PE hash，唔等於 flat hash）：`SHA256 0x84CA5E87042EF4AB51E716B4FB42EDAFCE8403D8F5F84CABCCE89D100695C9AD`
- 回復點：`qm snapshot 210 pre-applocker-test`（2026-11-28 16:52:18）已存在，測試前確認；測試後**保留**作回復點（見第 8 節）。

## 基準狀態（測試前，實測輸出）

| 項目 | 值 | 指令 |
|---|---|---|
| AppLocker 有效原則 | `<AppLockerPolicy Version="1" />`（無任何規則） | `Get-AppLockerPolicy -Effective -Xml` |
| AppIDSvc | Running（Manual） | `Get-Service AppIDSvc` |
| SAC | `VerifiedAndReputablePolicyState = 2`（Evaluation，唔會 enforce） | `Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -Name VerifiedAndReputablePolicyState` |
| WDAC | 8 個 `.cip`，全部 mtime 2024-04-01（Windows 內建，非本測試套用）；`MSFT_CIInfo` 類別在此 build 不存在（`Invalid class`） | `Get-ChildItem C:\Windows\System32\CodeIntegrity\CiPolicies\Active\*.cip`、`Get-CimInstance -Namespace root/Microsoft/Windows/CI -ClassName MSFT_CIInfo` |
| CodeIntegrity/Operational | 測試期間無任何事件（無 3077/3082 阻擋） | `Get-WinEvent -LogName 'Microsoft-Windows-CodeIntegrity/Operational'` |

WDAC `.cip` 檔名（全部內建、非本次套用）：
`{0283AC0F-FFF1-49AE-ADA1-8A933130CAD6}`、`{0939ED82-BFD5-4D32-B58E-D31D3C49715A}`、`{1283AC0F-FFF1-49AE-ADA1-8A933130CAD6}`、`{1678656C-05EF-481F-BC5B-EBD8C991502D}`、`{1939ED82-BFD5-4D32-B58E-D31D3C49715A}`、`{2678656C-05EF-481F-BC5B-EBD8C991502D}`、`{784C4414-79F4-4C32-A6A5-F0FB42A51D0D}`、`{A072029F-588B-4B5E-B7F9-05AAD67DF687}`

### 標準用戶（必須）
AppLocker 預設規則含「BUILTIN\Administrators 全部允許」例外，所以用管理員帳戶測試會假陰性。本次用 `stduser`（`New-LocalUser`，非 Administrators，`whoami /groups` 無 `BUILTIN\Administrators`），並以 `CreateProcessWithLogonW`（LOGON_WITH_PROFILE）在 session 1 以 stduser token 啟動，令 AppLocker 以非管理員 token 判定。

## 逐項測試結果

### 1a 基準（無任何原則）— 可執行：**Y**
- 設定指令：無（`Get-AppLockerPolicy -Effective -Xml` = `<AppLockerPolicy Version="1" />`）
- 執行：stduser token 啟動 exe → `RESULT=STARTED pid=2172`，`alive_after_15s=True`
- 事件：無 AppLocker 事件
- 證據：`t0b-baseline-stduser.log`

### 1b AppLocker 預設規則 + AuditOnly — 可執行：**Y（但會被擋）**
- 註：此 build 的 `New-AppLockerPolicy` **沒有 `-DefaultRule` 參數**（`ParameterBindingException: NamedParameterNotFound`），故以等價的預設規則 XML 套用（原文見下）。
- 設定指令：
```powershell
Set-AppLockerPolicy -XmlPolicy C:\aptest\policy-p2b-audit.xml
# policy-p2b-audit.xml:
# <AppLockerPolicy Version="1"><RuleCollection Type="Exe" EnforcementMode="AuditOnly">
#   <FilePathRule Id="11111111-2222-3333-4444-555555555551" Name="(Default Rule) All files located in the Program Files folder" UserOrGroupSid="S-1-1-0" Action="Allow"><Conditions><FilePathCondition Path="%PROGRAMFILES%\*" /></Conditions></FilePathRule>
#   <FilePathRule Id="11111111-2222-3333-4444-555555555552" Name="(Default Rule) All files located in the Windows folder" UserOrGroupSid="S-1-1-0" Action="Allow"><Conditions><FilePathCondition Path="%WINDIR%\*" /></Conditions></FilePathRule>
#   <FilePathRule Id="11111111-2222-3333-4444-555555555553" Name="(Default Rule) All files" UserOrGroupSid="S-1-5-32-544" Action="Allow"><Conditions><FilePathCondition Path="*" /></Conditions></FilePathRule>
# </RuleCollection></AppLockerPolicy>
Test-AppLockerPolicy -XmlPolicy C:\aptest\policy-p2b-audit.xml -Path <exe> -User WIN-ACCEPT\stduser
```
- `Test-AppLockerPolicy` 預測：`PolicyDecision = DeniedByDefault`
- 實際結果：`RESULT=STARTED pid=7048`，`alive_after_15s=True`
- **事件 8003（Warning）原文**：`%OSDRIVE%\WORK\ACCEPT247\SMARTSSH-1.0.247-PORTABLE-X64.EXE was allowed to run but would have been prevented from running if the AppLocker policy were enforced.`
- 證據：`p2b-audit.log`、`t1-audit-stduser.log`

### 1c AppLocker 預設規則 + Enforce — 可執行：**N**
- 設定指令：同上 XML，`EnforcementMode="Enabled"` → `Set-AppLockerPolicy -XmlPolicy C:\aptest\policy-p3-enforce.xml`
- 實際結果：`RESULT=BLOCKED_OR_FAILED last_error=1260`
- **錯誤原文**：`This program is blocked by group policy. For more information, contact your system administrator`（`System.ComponentModel.Win32Exception (0x80004005)`，NativeErrorCode 1260 = ERROR_ACCESS_DISABLED_BY_POLICY）
- **事件 8004（Error）原文**：`%OSDRIVE%\WORK\ACCEPT247\SMARTSSH-1.0.247-PORTABLE-X64.EXE was prevented from running.`（18:03:03）
- 證據：`t3-enforce-stduser.log`、`diag-events.log`

### 1d 同一 Enforce 原則下用管理員帳戶（假陰性示範）— 可執行：**Y**
- 執行：以 `hermes`（Administrators，並因本機 `EnableLUA=0` 全程 elevated）啟動同一 exe
- 結果：`RESULT=STARTED pid=6864`，`alive_after_10s=True`
- 事件 8002（Information）原文：`%OSDRIVE%\WORK\ACCEPT247\SMARTSSH-1.0.247-PORTABLE-X64.EXE was allowed to run.`
- 結論：**同一個 exe、同一原則下，管理員 allowed、標準用戶 blocked** — 證實用管理員帳戶測受管端點會得出假陰性。
- 證據：`t4b-enforce-hermes.log`

### 2 Publisher 規則（未簽名 ⇒ 建唔到）— 可建立：**N**
- 指令：`Get-AppLockerFileInformation -Path <exe>` → `Publisher` 欄位為空；再 `New-AppLockerPolicy -FileInformation $fi -RuleType Publisher -User Everyone -Xml`
- **錯誤原文**：`The rules cannot be created. Required file information is missing from the following file: %OSDRIVE%\WORK\ACCEPT247\SMARTSSH-1.0.247-PORTABLE-X64.EXE`
  （`FullyQualifiedErrorId: Microsoft.Security.ApplicationId.PolicyManagement.MissingFileInformationException,...NewAppLockerPolicyCmdlet`）
- 結論：未簽名 exe **無法**用 Publisher 規則白名單（唔簽名就冇 publisher 可認），所以簽名與否直接決定「一次性白名單」可行性。
- 證據：`diag-cmd2.log`

### 3 Hash 規則（該檔 SHA256 PE hash）— 可執行：**Y（但只限該檔，見第 5 節致命限制）**
- 指令：
```powershell
$fi = Get-AppLockerFileInformation -Path 'C:\work\accept247\smartssh-1.0.247-portable-x64.exe'
New-AppLockerPolicy -FileInformation $fi -RuleType Hash -User Everyone -Xml   # 產生規則
# 併入 enforce 預設規則後：
Set-AppLockerPolicy -XmlPolicy C:\aptest\policy-p5-hash.xml
```
- 產生規則原文（節錄）：`<FileHashRule Id="ac3fa931-fa18-4c83-90c9-acd9a44d09d8" Name="smartssh-1.0.247-portable-x64.exe" UserOrGroupSid="S-1-1-0" Action="Allow"><Conditions><FileHashCondition><FileHash Type="SHA256" Data="0x84CA5E87042EF4AB51E716B4FB42EDAFCE8403D8F5F84CABCCE89D100695C9AD" SourceFileName="smartssh-1.0.247-portable-x64.exe" SourceFileLength="127719041" /></FileHashCondition></Conditions></FileHashRule>`
- `Test-AppLockerPolicy`：`Allowed`，`MatchingRule = smartssh-1.0.247-portable-x64.exe`
- 實際結果：`RESULT=STARTED pid=6744`，事件 8002 `… was allowed to run.`
- 注意：每出新版本 exe，PE hash 改變 ⇒ 要再加一條新規則。
- 證據：`p5-hash.log`、`t5-hash-stduser.log`

### 4 預設規則已覆蓋 Program Files（唔加任何規則）— 可執行：**Y**
- 將 exe 放到 `C:\Program Files\SmartSSH\`（`Users:(RX)`），原則 = enforce 預設規則（無自訂規則）
- 結果：`RESULT=STARTED pid=2044`，`alive_after_12s=True`
- 結論：裝在 `%PROGRAMFILES%` 之下，預設規則本身已允許，**唔需要加任何白名單規則**。
- 證據：`t6-progfiles-stduser.log`

### 5 自訂 Path 規則（非 Program Files 路徑）— 可執行：**Y**
- 先確認未加規則時 `C:\Apps\SmartSSH\` 會被擋：`RESULT=BLOCKED_OR_FAILED last_error=1260`（`t7-apps-stduser.log`）
- 加規則：
```powershell
# Set-AppLockerPolicy -XmlPolicy C:\aptest\policy-p8-path.xml（enforce 預設規則 + 以下一條）
<FilePathRule Id="aaaaaaaa-2222-3333-4444-555555555554" Name="Smart SSH install folder"
  Description="Allows everyone to run files in the Smart SSH install folder"
  UserOrGroupSid="S-1-1-0" Action="Allow">
  <Conditions><FilePathCondition Path="C:\Apps\SmartSSH\*" /></Conditions>
</FilePathRule>
```
- `Test-AppLockerPolicy`：`Allowed`，`MatchingRule = Smart SSH install folder`
- 結果：`RESULT=STARTED pid=3708`，事件 8002 `%OSDRIVE%\APPS\SMARTSSH\SMARTSSH-1.0.247-PORTABLE-X64.EXE was allowed to run.`
- 結論：Path 規則一次設定、唔需每版更新（前提係檔案唔再搬路徑）。
- 證據：`p8-path.log`、`t8-path-stduser.log`

### 6 致命限制：portable exe 會自解壓到 %LOCALAPPDATA%\Temp，被 AppLocker 擋（hash／path 規則都救唔到）
- 現象：`smartssh-1.0.247-portable-x64.exe` 係 NSIS portable 自解壓包，啟動後解壓到
  `C:\Users\stduser\AppData\Local\Temp\3MJHKUI0VCIUDE9ZC0ZDBP24NAX\Smart SSH.exe` 再執行。
- **事件 8004 原文（重複出現 5 次：18:29:22、18:35:58、18:38:31、18:41:03、18:45:14）**：
  `%OSDRIVE%\USERS\STDUSER\APPDATA\LOCAL\TEMP\3MJHKUI0VCIUDE9ZC0ZDBP24NAX\SMART SSH.EXE was prevented from running.`
- 後果：就算已加 hash 規則（第 3 節）或加了 exe 所在目錄的 path 規則（第 5 節），**launcher 會成功啟動但 payload 被擋**，約 35–45 秒後以 exit code 1 靜靜退出（實測 `EXITCODE=1`，18:35:16→18:36:00），畫面無任何錯誤對話框、無 stdout/stderr。
- 即係：**現行 portable exe 在 AppLocker enforce 的受管端點上，就算白名單了它本身都跑唔起**。
- 證據：`diag-8004.log`、`startup-run.log`（C:\Apps 版本）、`diag-std.log`／`diag-std2.log`（exit_code=1）

### 7 解法（實測有效）：解壓後的 app 放 Program Files — 可執行：**Y，並在標準用戶 session 內截圖**
- 做法（管理員，一次）：把 portable payload 解壓目錄整個複製到 `C:\Program Files\SmartSSH\app\`，
  主程式 `C:\Program Files\SmartSSH\app\Smart SSH.exe`（unsigned，`Get-AuthenticodeSignature` = NotSigned，
  AppLocker PE hash `0x1B622CD259CEFEA6390149EFAED6B1E87D81446D423B2CB74FD0B6CB292D23C5`，247 MB）。
- 無需任何額外 AppLocker 規則（預設規則 `%PROGRAMFILES%\*` 已覆蓋）。
- stduser 以自己 session（console session 1）登入啟動：5 個 `Smart SSH.exe` 進程、12 個 plugin 全部載入
  （tabby-core/local/ssh/terminal/settings/serial/telnet/electron/linkifier/plugin-manager/community-color-schemes/auto-sudo-password）。
- 截圖證據 `ci-status/applocker-44d3cb33.png`：Smart SSH 視窗內 PowerShell tab，
  `PS C:\Users\stduser> whoami` → `win-accept\stduser`。
- 已知非阻擋性訊息（本機手動解壓所致，非產品缺陷）：`ENOENT app-update.yml`（updater 檢查）、
  `Could not start cmd.exe: File not found`（`CMD (clink)` profile 在此解壓佈局下 spawn 失敗，改用 PowerShell profile 正常）。
- 證據：`install-unpacked.log`、`startup-run.log`（Program Files 版本）、`whoami1.png`

### 8 Smart App Control
- 實測值：`VerifiedAndReputablePolicyState = 2`（**Evaluation**，唔係 Off、亦唔係 On）。
- 行為：Evaluation 模式下未簽名 exe 照跑（第 1a 節基準即為證據），CodeIntegrity/Operational 無任何事件 ⇒ SAC 在此機無阻擋作用。
- 限制：SAC 只可在消費級全新安裝（或重設 Windows）時開啟；Enterprise Evaluation 無法由 IT 直接切換為 On，故「SAC 會否擋未簽名 exe」在企業版機上不適用，本節只記錄實際值。

### 9 白名單無效時的連帶影響（實測副作用，值得 Hactl IT 注意）
套用 AppLocker 預設規則 + Enforce 後，**非**我方規則覆蓋的系統組件同樣被擋：
- `%OSDRIVE%\PROGRAMDATA\MICROSOFT\WINDOWS DEFENDER\PLATFORM\4.18.26100.4-0\DEFENDERSESSIONHELPER.EXE was prevented from running.`（多次）
- `%OSDRIVE%\PROGRAMDATA\MICROSOFT\WINDOWS DEFENDER\PLATFORM\4.18.26100.4-0\DEFENDERAIPLATFORMHOST.EXE was prevented from running.`（多次）
- `%OSDRIVE%\USERS\STDUSER\APPDATA\LOCAL\MICROSOFT\ONEDRIVE\23.081.0416.0001\FILESYNCCONFIG.EXE was prevented from running.`
即純預設規則會連 Windows Defender 平台 helper 都擋（預設規則只覆蓋 `%PROGRAMFILES%`、`%WINDIR%`），現實部署必須自己加相應允許規則。

## 回復（復原證據）

- 指令：`Set-AppLockerPolicy -XmlPolicy C:\aptest\orig-policy.xml`（orig 於測試前以 `Get-AppLockerPolicy -Local -Xml` 擷取 = `<AppLockerPolicy Version="1" />`）
- 復原後實測：
  - `Get-AppLockerPolicy -Effective -Xml` → `<AppLockerPolicy Version="1" />`
  - `Get-AppLockerPolicy -Local -Xml` → `<AppLockerPolicy Version="1" />`
  - `Get-Service AppIDSvc` → Running；SAC 仍為 `2`（未改動）
  - `stduser` 已刪除（`Remove-LocalUser` 成功；Administrators 只剩 `WIN-ACCEPT\Administrator`、`WIN-ACCEPT\hermes`）
  - `C:\Apps`、`C:\Program Files\SmartSSH`、StartUp 的 `SmartSSH.bat` 全部移除
  - StartUp 內的 `SmartSSH.bat`／`.lnk` 已清除；Winlogon 自動登入設定已還原為 `hermes`（測試期間曾暫設為 `stduser` 以便取得標準用戶 session）
  - `qm status 210` = **running**；guest console session 1 已由 `hermes` 登入
  - 復原後以 hermes 重新啟動 `C:\work\accept247\smartssh-1.0.247-portable-x64.exe`：`alive_after_40s=True`，無任何 AppLocker 事件 ⇒ 原則已回基準，下一次 `smartssh/verify/windows-checklist.ps1` 驗收不受影響（本次未重跑整個 checklist，因為它需要 session 1 互動桌面；已用「原則 XML 回到空 + exe 可執行」兩點證明）。
- **snapshot `pre-applocker-test` 保留**（未 `qm delsnapshot`），作額外回復點；如需清理：`qm delsnapshot 210 pre-applocker-test`。

## Verdict

**`PATH_RULE_ONE_TIME`**

- 一次性 path 規則（或直接裝在 `%PROGRAMFILES%` 用預設規則）可以令未簽名 Smart SSH 在 AppLocker enforce 的受管端點上運行，且**唔需要每版更新 hash**。
- **但前提係部署「解壓後／安裝式」佈局**（例如 `C:\Program Files\SmartSSH\app\Smart SSH.exe`）。
- 現行 `smartssh-1.0.247-portable-x64.exe` 自解壓到 `%LOCALAPPDATA%\Temp`，payload 被擋，**hash 規則與 install-path 規則都救唔到**（第 6 節實測），所以「派 portable exe + 加白名單」在 AppLocker enforce 環境下 **不可行**。
- 未簽名 ⇒ 冇 Publisher 規則（第 2 節原文），所以唯一「唔需每版更新」的路是 path 規則 + 固定安裝路徑。

## 未測／邊界
- 未在真實 Hactl domain 環境（GPO 派發、AppLocker 由 domain policy 下發）測試，全部為 VM 210 本機原則。
- 未測 DLL 規則集合（本次只啟用 Exe 集合）；若 Hactl 啟用 DLL 規則，hash/path 覆蓋面需另測。
- 未測 WDAC 自訂原則（本機無自訂 WDAC 政策，只有內建 `.cip`），亦無從在此機新增 WDAC 政策（屬 Hactl IT 決定）。
- 未測 SmartScreen 下載警告（與本卡無關；portable exe 從本機複製，無 Mark-of-the-Web）。
- 未跑完整 `windows-checklist.ps1`（見回復章節說明）。
