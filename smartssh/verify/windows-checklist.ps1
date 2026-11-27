# Smart SSH — Windows acceptance helper (three-state: PASS / FAIL / SKIPPED).
#   powershell -ExecutionPolicy Bypass -File windows-checklist.ps1 `
#       -Exe .\smartssh-1.0.238-portable-x64.exe -ExpectedSha <sha256> [-MetricsPath .\data\metrics.json]
# Exit codes: 0 = no FAIL (skips allowed), 2 = at least one FAIL, 1 = exe missing.
# Every measurement prints its NUMBER, not just PASS/FAIL, so a 5px regression is visible.

param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [Parameter(Mandatory = $true)][string]$ExpectedSha,
    [string]$MetricsPath
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
# The assertions live in smartssh/core/metrics.mjs (tested, 13/13) so the Windows side never
# re-implements them. No metrics file, or no node => SKIPPED with the reason, never PASS.
if (-not $MetricsPath) {
    $candidate = Join-Path (Split-Path $item.FullName) "data\metrics.json"
    if (Test-Path $candidate) { $MetricsPath = $candidate }
}
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $MetricsPath -or -not (Test-Path $MetricsPath)) {
    Skip "UI metrics" "no data\metrics.json next to the exe - run it with SMARTSSH_MEASURE=1 (or pass -MetricsPath)"
} elseif (-not $node) {
    Skip "UI metrics" "node not found on PATH; run: node smartssh\core\metrics-check.mjs --metrics $MetricsPath"
} else {
    $judge = Join-Path (Split-Path $PSScriptRoot -Parent) "core\metrics-check.mjs"
    $binfo = Join-Path (Split-Path $item.FullName) "resources\extras\smartssh-buildinfo.json"
    $argv = @($judge, "--metrics", $MetricsPath)
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
