# Smart SSH — Windows acceptance helper (three-state: PASS / FAIL / SKIPPED).
#   powershell -ExecutionPolicy Bypass -File windows-checklist.ps1 `
#       -Exe .\smartssh-1.0.238-portable-x64.exe -ExpectedSha <sha256> [-MetricsPath .\data\metrics.json]
# Exit codes: 0 = no FAIL (skips allowed), 2 = at least one FAIL, 1 = exe missing,
#             3 = Microsoft Visual C++ 2015–2022 x64 Redistributable missing (nothing was measured).
# The UI metrics judge receives the computed hash of this exe via --exe-sha.
# Every measurement prints its NUMBER, not just PASS/FAIL, so a 5px regression is visible.
#
# This file is UTF-8 **with BOM** on purpose: PowerShell 5.1 decodes a BOM-less script as ANSI, which
# would garble the Chinese half of the runtime message below (and make exit 3 unreadable).
#
# Section 0 runs before every measurement, including the sha256 check: on an image without the VC++
# runtime the shipped exe stops on its splash screen and the checklist would otherwise report a
# mystery failure at a later step instead of the actual cause.

param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [Parameter(Mandatory = $true)][string]$ExpectedSha,
    [string]$MetricsPath,
    # Self-test seam only: replace the probed directories so "no runtime installed" can be simulated
    # in an isolated directory on any machine (never rename System32 DLLs to test this). When this is
    # used the script says so loudly in the output, so a run with an override cannot pass unnoticed.
    [string[]]$RuntimeDirs
)

$ErrorActionPreference = 'Stop'
$script:fail = 0
$script:skip = 0

function Check($name, $ok, $detail) {
    if ($ok) { Write-Host ("PASS     " + $name + "  " + $detail) -ForegroundColor Green }
    else { Write-Host ("FAIL     " + $name + "  " + $detail) -ForegroundColor Red; $script:fail++ }
}
function Skip($name, $why) {
    Write-Host ("SKIPPED  " + $name + "  " + $why) -ForegroundColor Yellow; $script:skip++
}
function Info($name, $value) { Write-Host ("MEASURE  " + $name + " = " + $value) -ForegroundColor Cyan }

# ---- 0. VC++ 2015-2022 x64 runtime preflight (before ANY measurement) -----------------------------
# Without this runtime `russh.win32-x64-msvc.node` fails to load (Windows error 126) and the exe never
# leaves its splash screen. Constants below are mirrored from smartssh/app/vcredist.mjs; the drift
# test smartssh/verify/vcredist-preflight.test.mjs fails when the two disagree.
$vcredistDlls = @('vcruntime140.dll', 'msvcp140.dll')
$vcredistTitle = '需要 Microsoft Visual C++ 2015–2022 x64 Redistributable'
$vcredistUrl = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
$vcredistDocs = 'https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist'

$searchDirs = @()
if ($RuntimeDirs) {
    $searchDirs = @($RuntimeDirs)
    Info 'vc++-runtime dirs override' ($searchDirs -join '; ')
} else {
    # Most specific first: a DLL next to the exe (app-local deployment) is what the process loads.
    # $Exe may not exist yet — Split-Path is a string operation, and the exe check is step 1.
    $exeDir = Split-Path -Parent $Exe
    foreach ($d in @($env:PORTABLE_EXECUTABLE_DIR, $exeDir)) {
        if ($d) { $searchDirs += $d }
    }
    if ($env:SystemRoot) { $searchDirs += (Join-Path $env:SystemRoot 'System32') }
}
# Deduplicate, keep order (Windows paths are case-insensitive).
$seen = @{}
$uniqueDirs = @()
foreach ($d in $searchDirs) {
    if (-not $d) { continue }
    $key = $d.ToLowerInvariant()
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    $uniqueDirs += $d
}
$searchDirs = $uniqueDirs

$foundDll = @{}
$missingDll = @()
foreach ($dll in $vcredistDlls) {
    $hit = $null
    foreach ($d in $searchDirs) {
        if (Test-Path (Join-Path $d $dll)) { $hit = $d; break }
    }
    if ($hit) { $foundDll[$dll] = $hit } else { $missingDll += $dll }
}

if ($missingDll.Count -gt 0) {
    Write-Host ''
    Write-Host ("FAIL     vc++-runtime  " + $vcredistTitle) -ForegroundColor Red
    Write-Host ("         missing/缺少     : " + ($missingDll -join ', '))
    Write-Host ("         searched/已搜尋   : " + ($searchDirs -join '; '))
    Write-Host  '         原因: SmartSSH 的 SSH 引擎是原生模組（russh.win32-x64-msvc.node），缺 runtime 時'
    Write-Host  '         Windows 回報 error 126（找不到相依 DLL），exe 永遠停在 splash。'
    Write-Host  '         why : the SSH engine is a native module; Windows fails to load it (error 126) and'
    Write-Host  '               the exe never leaves its splash screen.'
    Write-Host ("         download/下載 : " + $vcredistUrl)
    Write-Host ("         docs/說明     : " + $vcredistDocs)
    Write-Host  '         x64 build only. After installing, run this checklist again.'
    Write-Host  ('EXIT 3 = ' + $vcredistTitle + ' — no measurement was taken.')
    Write-Host ''
    exit 3
}
Check 'vc++-runtime' $true ("vcruntime140.dll=" + $foundDll['vcruntime140.dll'] + " msvcp140.dll=" + $foundDll['msvcp140.dll'])

if (-not (Test-Path $Exe)) { Write-Host "FAIL  exe not found: $Exe" -ForegroundColor Red; exit 1 }
$item = Get-Item $Exe
$hash = (Get-FileHash $item.FullName -Algorithm SHA256).Hash

# ---- 1. artifact integrity -------------------------------------------------
Check "sha256" ($hash -ieq $ExpectedSha) ("file=" + $hash + " expected=" + $ExpectedSha.ToUpper())
Check "size" ($item.Length -gt 100MB) ([math]::Round($item.Length / 1MB, 1).ToString() + " MB")
$sig = Get-AuthenticodeSignature $item.FullName
Check "signature" ($sig.Status -eq 'NotSigned') ("status=" + $sig.Status)

# baseline for the "update check must not replace the exe" assertion
[ordered]@{ hash = $hash; mtime = $item.LastWriteTimeUtc; size = $item.Length } |
    ConvertTo-Json | Out-File -Encoding utf8 "$($item.BaseName).before.json"
Info "baseline" "$($item.BaseName).before.json"

# ---- 2. portable wrapper behaviour ----------------------------------------
$ro = Join-Path $env:TEMP ("smartssh-ro-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $ro | Out-Null
Copy-Item $item.FullName $ro
$acl = Get-Acl $ro
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    [System.Security.Principal.WindowsIdentity]::GetCurrent().Name, "CreateFiles,WriteData", "ContainerInherit,ObjectInherit", "None", "Deny")
$acl.AddAccessRule($rule)
Set-Acl $ro $acl
try {
    $p = Start-Process -FilePath (Join-Path $ro $item.Name) -PassThru -WindowStyle Minimized
    Start-Sleep -Seconds 8
    Check "read-only launch survives" (-not $p.HasExited) ("pid=" + $p.Id + " exited=" + $p.HasExited)
    Check "no silent fallback to %LOCALAPPDATA%" (-not (Test-Path (Join-Path $ro "data"))) ("data dir created=" + (Test-Path (Join-Path $ro "data")))
    if (-not $p.HasExited) { $p.CloseMainWindow() | Out-Null; Start-Sleep -Seconds 2; if (-not $p.HasExited) { $p.Kill() } }
} finally {
    $acl.RemoveAccessRule($rule) | Out-Null
    try { Set-Acl $ro $acl } catch { }
    Remove-Item $ro -Recurse -Force -ErrorAction SilentlyContinue
}

# ---- 3. UI measurements (delegated to the node judge) ----------------------
# The assertions live in smartssh/core/metrics.mjs so the Windows side never
# re-implements them. No metrics file, or no node => SKIPPED with the reason, never PASS.
if (-not $MetricsPath) {
    $candidate = Join-Path (Split-Path $item.FullName) "data\metrics.json"
    if (Test-Path $candidate) { $MetricsPath = $candidate }
}
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $MetricsPath -or -not (Test-Path $MetricsPath)) {
    Skip "UI metrics" "no data\metrics.json next to the exe - run it with SMARTSSH_MEASURE=1 (or pass -MetricsPath)"
} elseif (-not $node) {
    Skip "UI metrics" "node not found on PATH; run: node smartssh\core\metrics-check.mjs --metrics $MetricsPath --exe-sha $hash"
} else {
    $judge = Join-Path (Split-Path $PSScriptRoot -Parent) "core\metrics-check.mjs"
    $binfo = Join-Path (Split-Path $item.FullName) "resources\extras\smartssh-buildinfo.json"
    $argv = @($judge, "--metrics", $MetricsPath)
    $argv += @('--exe-sha', $hash)
    if (Test-Path $binfo) { $argv += @("--buildinfo", $binfo) }
    & $node.Source @argv
    $code = $LASTEXITCODE
    if ($code -eq 0) { Write-Host "PASS     UI metrics judged (see lines above)" -ForegroundColor Green }
    else { Write-Host "FAIL     UI metrics judged (see lines above)" -ForegroundColor Red; $script:fail++ }
}

Write-Host ""
if ($script:fail -eq 0) { Write-Host ("ALL CHECKS PASSED (skipped: " + $script:skip + ")") -ForegroundColor Green; exit 0 }
Write-Host ("FAILED CHECKS: " + $script:fail + "  (skipped: " + $script:skip + ")") -ForegroundColor Red
exit 2
