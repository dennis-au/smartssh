import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const checklist = readFileSync(new URL('./windows-checklist.ps1', import.meta.url), 'utf8').replace(/^\uFEFF/, '')
const helper = fileURLToPath(new URL('./judgeFailure.ps1', import.meta.url))
const helperSource = readFileSync(helper, 'utf8')

let fails = 0
function t (name, fn) {
  try {
    fn()
    console.log('PASS  ' + name)
  } catch (error) {
    fails++
    console.error('FAIL  ' + name, error)
  }
}

t('the Windows checklist keeps the judge transcript and prints each failure reason', () => {
  assert.match(helperSource, /^function Get-JudgeFailureLines\s*\{/m)
  assert.match(checklist, /^\. \(Join-Path \$PSScriptRoot "judgeFailure\.ps1"\)$/m)
  assert.match(checklist, /& \$node\.Source @argv 2>&1 \| ForEach-Object \{[^}]*Write-Host \$line/)
  const branch = checklist.match(/if \(\$code -ne 0\) \{([\s\S]*?)\} else \{/)
  assert.ok(branch, 'missing judge failure branch')
  assert.match(branch[1], /foreach \(\$reason in \(Get-JudgeFailureLines -Lines \$judgeLines\)\)/)
  assert.match(branch[1], /Write-Host "FAIL     UI metrics  \$reason" -ForegroundColor Red/)
  assert.doesNotMatch(branch[1], /FAIL     UI metrics judged \(see lines above\)/)
  assert.equal((branch[1].match(/\$script:fail\+\+/g) ?? []).length, 1)
})

const psHost = ['pwsh', 'powershell'].find(name => {
  const probe = spawnSync(name, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' })
  return !probe.error && probe.status === 0
})

if (!psHost) {
  console.log('SKIPPED  behavioural judge reason test: no PowerShell host on PATH (pwsh / powershell)')
} else {
  t('PowerShell extracts the zero-live failure, ignores counts, and handles missing diagnostics', () => {
    const reason = 'at least one case is a live measurement (measured:true)  no live measurement: 0 of 3 cases are measured:true; every case is declared'
    const dir = mkdtempSync(join(tmpdir(), 'smartssh-judge-reason-'))
    try {
      const script = join(dir, 'judge-reason-test.ps1')
      writeFileSync(script, `param([string] $Helper)
$ErrorActionPreference = 'Stop'
. $Helper
$counts = @('50 pass / 0 fail / 0 skipped', 'live measurements: 0/3 (measured:true only; declared cases excluded)')
Get-JudgeFailureLines -Lines ($counts + @('JUDGE FAILED (1):', '  JUDGE FAIL: ${reason}'))
Get-JudgeFailureLines -Lines @('FAIL     ${reason}', '  JUDGE FAIL: ${reason}', 'metrics invalid: empty', 'metrics invalid: empty', 'cannot read metrics: missing', 'exe sha256 must be 64 hex', '--exe-sha does not match --exe')
Get-JudgeFailureLines -Lines (@('first line', '  last useful line  ') + $counts)
Get-JudgeFailureLines -Lines @('', '  ')
`)
      const run = spawnSync(psHost, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, helper], { encoding: 'utf8' })
      assert.ifError(run.error)
      assert.equal(run.status, 0, run.stdout + run.stderr)
      assert.match(run.stdout, /no live measurement/)
      assert.doesNotMatch(run.stdout, /50 pass/)
      assert.deepEqual(run.stdout.trim().split(/\r?\n/), [
        reason, reason, 'metrics invalid: empty', 'cannot read metrics: missing', 'exe sha256 must be 64 hex',
        '--exe-sha does not match --exe', 'last useful line', 'judge produced no output',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

process.exitCode = fails ? 1 : 0
