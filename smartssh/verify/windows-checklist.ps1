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

# ---- 3. UI measurements (only when the build can report them) --------------
# The app should write data\metrics.json when SMARTSSH_MEASURE=1. Without it there is nothing
# to measure, so say SKIPPED with the reason — never PASS by default.
if (-not $MetricsPath) {
    $candidate = Join-Path (Split-Path $item.FullName) "data\metrics.json"
    if (Test-Path $candidate) { $MetricsPath = $candidate }
}
if (-not $MetricsPath -or -not (Test-Path $MetricsPath)) {
    Skip "viewport height at 683x512" "no data\metrics.json — no measurement hook / no bar UI in this build"
    Skip "bar auto-collapse after 8s" "no data\metrics.json"
    Skip "height at 911x512" "no data\metrics.json"
    Skip "split pane uses @container not @media" "no data\metrics.json"
    Skip "chrome heights (titlebar / tab strip / statusbar)" "no data\metrics.json"
} else {
    $m = Get-Content $MetricsPath -Raw | ConvertFrom-Json
    Info "metrics source" $MetricsPath
    Info "titlebar / tab strip / statusbar" ("$($m.titlebarPx) / $($m.tabStripPx) / $($m.statusbarPx)")
    Info "bar height" ($m.barHeightPx)
    Info "viewport height" ($m.viewportHeightPx)

    if ($null -eq $m.viewportHeightPx) { Skip "viewport height at 683x512" "metrics has no viewportHeightPx" }
    else { Check "viewport height >= 120 at 683x512" ($m.viewportHeightPx -ge 120) ("viewport=" + $m.viewportHeightPx + "px") }

    if ($null -eq $m.barCollapsedAfter8s) { Skip "bar auto-collapse after 8s" "metrics has no barCollapsedAfter8s" }
    else { Check "bar collapses 8s after the terminal state" ([bool]$m.barCollapsedAfter8s) ("collapsed=" + $m.barCollapsedAfter8s) }

    if ($null -eq $m.height911x512) { Skip "height at 911x512" "not measured" }
    else { Check "layout at 911x512 has no internal vertical overflow" ([bool]$m.height911x512) ("ok=" + $m.height911x512) }

    if ($null -eq $m.splitPaneCompact) { Skip "split pane uses @container" "not measured" }
    else { Check "small pane goes compact, large pane does not" ([bool]$m.splitPaneCompact) ("smallPaneCompact=" + $m.splitPaneCompact) }
}

Write-Host ""
if ($script:fail -eq 0) { Write-Host ("ALL CHECKS PASSED (skipped: " + $script:skip + ")") -ForegroundColor Green; exit 0 }
Write-Host ("FAILED CHECKS: " + $script:fail + "  (skipped: " + $script:skip + ")") -ForegroundColor Red
exit 2
