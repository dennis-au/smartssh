# Smart SSH — Windows acceptance helper.
# Run on the Windows box that holds the downloaded portable exe:
#   powershell -ExecutionPolicy Bypass -File windows-checklist.ps1 -Exe .\smartssh-1.0.238-portable-x64.exe -ExpectedSha D6F27ADB...
# Exits non-zero on the first failed check so it can be used in a pipeline.

param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [Parameter(Mandatory = $true)][string]$ExpectedSha
)

$ErrorActionPreference = 'Stop'
$fail = 0

function Check($name, $ok, $detail) {
    if ($ok) { Write-Host ("PASS  " + $name + "  " + $detail) -ForegroundColor Green }
    else { Write-Host ("FAIL  " + $name + "  " + $detail) -ForegroundColor Red; $script:fail++ }
}

if (-not (Test-Path $Exe)) { Write-Host "FAIL  exe not found: $Exe" -ForegroundColor Red; exit 1 }
$item = Get-Item $Exe
$hash = (Get-FileHash $item.FullName -Algorithm SHA256).Hash

# 1. hash versus artifact-sha256.txt (case-normalised)
Check "sha256" ($hash -ieq $ExpectedSha) ("file=" + $hash + " expected=" + $ExpectedSha.ToUpper())

# 2. size sanity (a truncated download is the most common corruption)
Check "size" ($item.Length -gt 100MB) ([math]::Round($item.Length / 1MB, 1).ToString() + " MB")

# 3. unsigned build is expected (forceCodeSigning:false)
$sig = Get-AuthenticodeSignature $item.FullName
Check "signature" ($sig.Status -eq 'NotSigned') ("status=" + $sig.Status)

# 4. record what we must NOT see change after a later run (self-replace check)
$before = [ordered]@{ hash = $hash; mtime = $item.LastWriteTimeUtc; size = $item.Length }
$before | ConvertTo-Json | Out-File -Encoding utf8 "$($item.BaseName).before.json"
Write-Host ("INFO  baseline written to " + $item.BaseName + ".before.json")

# 5. read-only container: the first onboarding cell must go red, and the process must not crash
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
    Check "readonly launch survives" (-not $p.HasExited) ("pid=" + $p.Id + " exited=" + $p.HasExited)
    if (-not $p.HasExited) { $p.CloseMainWindow() | Out-Null; Start-Sleep -Seconds 2; if (-not $p.HasExited) { $p.Kill() } }
    Check "no silent fallback" (-not (Test-Path (Join-Path $ro "data"))) ("data dir created=" + (Test-Path (Join-Path $ro "data")))
} finally {
    $acl.RemoveAccessRule($rule) | Out-Null
    try { Set-Acl $ro $acl } catch { }
    Remove-Item $ro -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
if ($fail -eq 0) { Write-Host "ALL CHECKS PASSED" -ForegroundColor Green; exit 0 }
Write-Host ("FAILED CHECKS: " + $fail) -ForegroundColor Red
exit 2
