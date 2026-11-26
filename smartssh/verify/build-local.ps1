# Smart SSH — local Windows build (no GitHub Actions, zero CI minutes).
#   powershell -ExecutionPolicy Bypass -File build-local.ps1 [-Version 1.0.238]
# Requires: node 22, yarn, VS Build Tools (node-pty/conpty native build), ~10 GB free.
# Produces: dist\smartssh-<version>-portable-x64.exe  + artifact-sha256.txt

param([string]$Version = "1.0.238")

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)   # repo root (script lives in smartssh\verify)

# 1. version must be pinned, otherwise vars.mjs falls back to 0.0.0-dev
$env:SMARTSSH_VERSION = $Version
Write-Host "SMARTSSH_VERSION=$env:SMARTSSH_VERSION"

# 2. local build counter: local.<n> keeps every bug report identifiable
$counterFile = "smartssh\local-build.txt"
$n = 1
if (Test-Path $counterFile) { $n = [int](Get-Content $counterFile -Raw).Trim() + 1 }
[IO.File]::WriteAllText((Join-Path $PWD $counterFile), "$n`n", (New-Object Text.UTF8Encoding($false)))
$build = "local.$n"
Write-Host "build=$build"

# 3. buildinfo, UTF-8 without BOM (a BOM makes JSON.parse throw and the app shows "dev")
$commit = "local"
try { $commit = (git rev-parse --short HEAD).Trim() } catch { }
$info = [ordered]@{
    base    = $Version
    build   = $build
    commit  = $commit
    builtAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
}
New-Item -ItemType Directory -Force -Path extras | Out-Null
[IO.File]::WriteAllText((Join-Path $PWD "extras\smartssh-buildinfo.json"), ($info | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
Get-Content "extras\smartssh-buildinfo.json"

# 4. install + build + package
npm i -g yarn --silent
Push-Location app; yarn --network-timeout 1000000; Pop-Location
yarn --network-timeout 1000000
yarn run build
node scripts/build-smartssh.mjs

# 5. hash the artifact
$lines = @()
Get-ChildItem dist -Filter *portable*.exe | ForEach-Object {
    $h = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
    $lines += "$($_.Name)  $h"
    Write-Host "$($_.Name)  $h"
}
[IO.File]::WriteAllLines((Join-Path $PWD "artifact-sha256.txt"), $lines, (New-Object Text.UTF8Encoding($false)))

Write-Host ""
Write-Host "Built: $build  (commit $commit)"
Write-Host "Next: powershell -File smartssh\verify\windows-checklist.ps1 -Exe dist\smartssh-$Version-portable-x64.exe -ExpectedSha <hash above>"
