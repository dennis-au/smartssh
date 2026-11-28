// smartssh/verify/vcredist-preflight.test.mjs — the acceptance checklist must name a missing VC++
// runtime *before* it measures anything, and the app must ask the same question at start-up.
//
// Why this file exists: the measured failure (VM 210, clean Windows 11 24H2) was an exe that drew its
// splash and never drew a window, because `russh.win32-x64-msvc.node` could not load (Windows error
// 126) on an image without the VC++ 2015–2022 x64 runtime. Two entry points have to catch that, and
// both have to say the same thing:
//   - smartssh/verify/windows-checklist.ps1  section 0, exit code 3, message with the download URL
//   - app/lib/index.ts (+ app/lib/vcredistPreflight.ts)  a dialog before any window is created
//
// Three parts:
//   1. static contract — the checklist's preflight precedes every measurement, carries the exact
//      wording/URL/DLL names from smartssh/app/vcredist.mjs (drift = failure), and the file keeps the
//      UTF-8 BOM that PowerShell 5.1 needs to read the Chinese half;
//   2. static wiring — index.ts probes before the window/app bootstrap and exits 3 when unresolved;
//   3. behavioural — when a PowerShell host exists, actually run the script twice: an isolated empty
//      directory (simulated clean image) must exit 3 and measure nothing, and a directory holding the
//      two DLLs must let it through to the exe check (exit 1). No host => SKIPPED with the reason, and
//      the Windows run on VM 210 is the evidence of record (see the task handoff), never a silent pass.
//
// Run: node smartssh/verify/vcredist-preflight.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
    EXIT_CODE_MISSING_RUNTIME,
    REDIST_DOCS_URL,
    REDIST_URL,
    RUNTIME_DLLS,
    RUNTIME_TITLE_ZH,
} from '../app/vcredist.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const CHECKLIST = path.join(REPO_ROOT, 'smartssh', 'verify', 'windows-checklist.ps1')
const INDEX_TS = path.join(REPO_ROOT, 'app', 'lib', 'index.ts')
const PREFLIGHT_TS = path.join(REPO_ROOT, 'app', 'lib', 'vcredistPreflight.ts')

const r = []
const skipped = []
const t = (name, fn) => {
    try { fn(); r.push(['PASS', name]) } catch (e) { r.push(['FAIL', name + ' :: ' + e.message]) }
}

const checklistBytes = fs.readFileSync(CHECKLIST)
const checklist = checklistBytes.toString('utf8').replace(/^\uFEFF/, '')
const indexTs = fs.readFileSync(INDEX_TS, 'utf8')
const preflightTs = fs.readFileSync(PREFLIGHT_TS, 'utf8')

function indexOfMatch (text, re, what) {
    const match = text.match(re)
    assert.ok(match, `${what} not found`)
    return match.index
}

// ------------------------------------------------------------ 1. static contract: the checklist

t('checklist keeps its UTF-8 BOM (PowerShell 5.1 would otherwise garble the Chinese message)', () => {
    assert.deepEqual([...checklistBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf])
})

t('preflight runs before the first measurement, not after it', () => {
    const preflight = indexOfMatch(checklist, /# ---- 0\. VC\+\+ 2015-2022 x64 runtime preflight/, 'preflight section')
    for (const [label, re] of [
        ['sha256 check', /Check "sha256"/],
        ['artifact integrity section', /# ---- 1\. artifact integrity/],
        ['portable launch', /Start-Process -FilePath/],
        ['UI metrics section', /# ---- 3\. UI measurements/],
        ['exe existence check', /FAIL  exe not found/],
    ]) {
        const at = indexOfMatch(checklist, re, label)
        assert.ok(preflight < at, `preflight must come before ${label} (preflight@${preflight}, ${label}@${at})`)
    }
})

t('preflight exits 3 (the code this suite pins) and measures nothing on the way out', () => {
    const exitAt = indexOfMatch(checklist, /exit 3/, 'exit 3')
    const shaAt = indexOfMatch(checklist, /Check "sha256"/, 'sha256 check')
    assert.ok(exitAt < shaAt, 'exit 3 must happen before the sha256 measurement')
    assert.equal(EXIT_CODE_MISSING_RUNTIME, 3)
})

t('checklist message carries the shared constants verbatim (no drift from vcredist.mjs)', () => {
    for (const needle of [RUNTIME_TITLE_ZH, REDIST_URL, REDIST_DOCS_URL, ...RUNTIME_DLLS]) {
        assert.ok(checklist.includes(needle), `windows-checklist.ps1 no longer contains: ${needle}`)
    }
    // The card's wording, spelled out rather than only via the constant.
    assert.ok(checklist.includes('需要 Microsoft Visual C++ 2015–2022 x64 Redistributable'))
})

t('preflight has the isolated-directory seam, and announces when it is used', () => {
    assert.match(checklist, /\[string\[\]\]\$RuntimeDirs/)
    assert.match(checklist, /vc\+\+-runtime dirs override/)
})

// ------------------------------------------------------------ 2. static contract: the app side

t('main process probes the runtime before any window can be created', () => {
    const probeAt = indexOfMatch(indexTs, /const runtimePreflight = runRuntimePreflight\(\)/, 'runRuntimePreflight() call')
    for (const [label, re] of [
        ['Application construction', /new Application\(configStore\)/],
        ['app ready handler', /app\.on\('ready'/],
        ['window creation', /application\.newWindow\(/],
    ]) {
        const at = indexOfMatch(indexTs, re, label)
        assert.ok(probeAt < at, `preflight must run before ${label}`)
    }
})

t('a failed preflight is presented as a dialog and exits 3 instead of starting', () => {
    assert.match(indexTs, /presentMissingRuntime\(runtimePreflight\)/)
    assert.match(indexTs, /app\.exit\(EXIT_CODE_MISSING_RUNTIME\)/)
    const presenterAt = indexOfMatch(indexTs, /presentMissingRuntime\(runtimePreflight\)/, 'presenter call')
    const initAt = indexOfMatch(indexTs, /application\.init\(\)/, 'application.init()')
    assert.ok(presenterAt < initAt, 'the dialog must be presented before application.init()')
})

t('the wrapper uses a blocking dialog with the download action and never auto-executes a download', () => {
    assert.match(preflightTs, /dialog\.showMessageBoxSync\(/)
    assert.match(preflightTs, /shell\.openExternal\(REDIST_URL\)/)
    assert.match(preflightTs, /findRedistInstaller\(/)
    assert.match(preflightTs, /\/install', '\/passive'/)
    // Downloads are the user's action in a browser; the app only runs an installer the user supplied.
    assert.ok(!/https?\.get\(|fetch\(|downloadFile|net\.request/.test(preflightTs),
        'the preflight must not download and execute a binary by itself')
})

t('the simulation seam can only force a failure, never a pass', () => {
    assert.match(preflightTs, /SMARTSSH_SIMULATE_MISSING_VCRUNTIME/)
    const start = preflightTs.indexOf('SIMULATE_ENV] ===')
    assert.ok(start > 0, 'simulation branch not found')
    const branch = preflightTs.slice(start, preflightTs.indexOf('return checkRuntime({ ...target', start))
    assert.match(branch, /exists: \(\) => false/, 'the simulation must not probe the real filesystem')
    assert.match(branch, /simulated \/ 模擬/, 'a simulated run must say so in the message')
})

// ------------------------------------------------------------ 3. behavioural (needs a PS host)

function findPowerShell () {
    const candidates = process.platform === 'win32' ? ['powershell.exe', 'pwsh.exe', 'pwsh'] : ['pwsh']
    for (const name of candidates) {
        const probe = spawnSync(name, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' })
        if (!probe.error && probe.status === 0) return name
    }
    return null
}

const psHost = findPowerShell()

function runChecklist (args) {
    const res = spawnSync(psHost, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', CHECKLIST,
        ...args,
    ], { encoding: 'utf8', timeout: 120_000 })
    assert.equal(res.error, undefined, `could not run ${psHost}: ${res.error?.message}`)
    return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

if (!psHost) {
    skipped.push('behavioural preflight run: no PowerShell host on PATH (pwsh / powershell.exe)')
} else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smartssh-vcredist-'))
    try {
        const empty = path.join(tmp, 'clean-image')
        const withRuntime = path.join(tmp, 'has-runtime')
        fs.mkdirSync(empty, { recursive: true })
        fs.mkdirSync(withRuntime, { recursive: true })
        for (const dll of RUNTIME_DLLS) fs.writeFileSync(path.join(withRuntime, dll), 'stub')
        const missingExe = path.join(tmp, 'no-such-exe.exe')

        t('isolated empty dir => exit 3, the runtime named, no measurement taken', () => {
            const { code, out } = runChecklist([
                '-Exe', missingExe, '-ExpectedSha', '0'.repeat(64), '-RuntimeDirs', empty,
            ])
            assert.equal(code, EXIT_CODE_MISSING_RUNTIME, `exit ${code}, output:\n${out}`)
            assert.ok(out.includes(RUNTIME_TITLE_ZH), `message lacks the runtime name:\n${out}`)
            assert.ok(out.includes(REDIST_URL), `message lacks the download URL:\n${out}`)
            assert.ok(!/sha256|MEASURE  baseline/.test(out), `a measurement happened anyway:\n${out}`)
            assert.ok(!/exe not found/.test(out), 'the exe check must not be reached first')
        })

        t('both DLLs present => preflight passes and the script moves on (exit 1, exe missing)', () => {
            const { code, out } = runChecklist([
                '-Exe', missingExe, '-ExpectedSha', '0'.repeat(64), '-RuntimeDirs', withRuntime,
            ])
            assert.equal(code, 1, `exit ${code}, output:\n${out}`)
            assert.match(out, /PASS\s+vc\+\+-runtime/)
            assert.match(out, /exe not found/)
            assert.ok(!out.includes(RUNTIME_TITLE_ZH), 'preflight message printed even though it passed')
        })
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true })
    }
}

// ------------------------------------------------------------ report

for (const [status, name] of r) console.log(`${status}  ${name}`)
for (const reason of skipped) console.log(`SKIPPED  ${reason}`)

const fails = r.filter(([status]) => status === 'FAIL').length
const skipNote = skipped.length > 0 ? `, ${skipped.length} skipped` : ''
console.log(`${r.length - fails}/${r.length} passed${skipNote}`)
if (skipped.length > 0) {
    console.log(`NOTE: the behavioural half of this file needs PowerShell; on Windows CI/VM it runs for real.`)
}
process.exit(fails ? 1 : 0)
