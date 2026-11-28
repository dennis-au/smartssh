// smartssh/app/metricsPath.test.mjs — the metrics file must never land in cwd.
//
// The failure this guards against is the one that shipped: `data/metrics.json` was a relative
// path, the exe was started from some other folder, and `windows-checklist.ps1` (which looks next
// to the exe) reported "UI metrics: SKIPPED" for a build that was writing the file all along.
// Run: node smartssh/app/metricsPath.test.mjs
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
    MEASURE_ENV, MEASURE_PATH_ENV, METRICS_RELATIVE_PATH,
    isMeasureEnabled, metricsBaseDir, resolveMetricsPath,
} from './metricsPath.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')

// Two real, distinct cwds. `process.chdir('/')` is not portable (on Windows '/' is the current
// drive root, and posix literals below are resolved with the win32 api on a win32 host), so the
// "cwd is not part of the answer" test uses temp dirs that exist on every platform.
const CWD_A = fs.mkdtempSync(join(os.tmpdir(), 'smartssh-cwd-a-'))
const CWD_B = fs.mkdtempSync(join(os.tmpdir(), 'smartssh-cwd-b-'))

let total = 0
let fails = 0
function test (name, fn) {
    total++
    try {
        fn()
        console.log(`PASS  ${name}`)
    } catch (error) {
        fails++
        console.log(`FAIL  ${name}`)
        console.log(`      ${error && error.message ? error.message : error}`)
    }
}

/** Run `fn` with the process cwd at `dir`, restoring it afterwards. */
function withCwd (dir, fn) {
    const before = process.cwd()
    process.chdir(dir)
    try { return fn() } finally { process.chdir(before) }
}

// ---------------------------------------------------------------- names

test('the switch is named SMARTSSH_MEASURE and the override SMARTSSH_MEASURE_PATH', () => {
    assert.equal(MEASURE_ENV, 'SMARTSSH_MEASURE')
    assert.equal(MEASURE_PATH_ENV, 'SMARTSSH_MEASURE_PATH')
    assert.equal(METRICS_RELATIVE_PATH, 'data/metrics.json')
})

// ---------------------------------------------------------------- the switch

test('isMeasureEnabled accepts exactly "1" (whitespace tolerated)', () => {
    assert.equal(isMeasureEnabled({ [MEASURE_ENV]: '1' }), true)
    assert.equal(isMeasureEnabled({ [MEASURE_ENV]: ' 1 ' }), true)
    for (const value of ['0', 'true', 'yes', '', '  ', 'on', undefined]) {
        assert.equal(isMeasureEnabled({ [MEASURE_ENV]: value }), false, `value=${JSON.stringify(value)}`)
    }
    assert.equal(isMeasureEnabled(undefined), false)
})

// ---------------------------------------------------------------- default path

test('default path is <exe dir>/data/metrics.json and absolute (posix rules)', () => {
    withCwd(CWD_A, () => {
        const out = resolveMetricsPath({}, '/opt/smartssh/smartssh.exe', 'linux')
        assert.equal(out, '/opt/smartssh/data/metrics.json')
        assert.equal(path.posix.isAbsolute(out), true)
    })
})

test('cwd is not part of the answer: two different cwds give the same file', () => {
    const seen = [CWD_A, CWD_B].map(dir => withCwd(dir, () => resolveMetricsPath({}, '/opt/smartssh/smartssh.exe', 'linux')))
    assert.equal(seen[0], seen[1])
    assert.equal(seen[0], '/opt/smartssh/data/metrics.json')
})

test('PORTABLE_EXECUTABLE_DIR wins over process.execPath (win32)', () => {
    const out = resolveMetricsPath(
        { PORTABLE_EXECUTABLE_DIR: 'D:\\Apps\\SmartSSH\\' },
        'C:\\Users\\me\\AppData\\Local\\Temp\\smartssh-1.0.238-portable-x64.exe',
        'win32')
    assert.equal(out, 'D:\\Apps\\SmartSSH\\data\\metrics.json')
})

test('no portable dir on win32 falls back to the exe directory, not userData', () => {
    const out = resolveMetricsPath({}, 'E:\\Tools\\SmartSSH\\smartssh.exe', 'win32')
    assert.equal(out, 'E:\\Tools\\SmartSSH\\data\\metrics.json')
})

test('metricsBaseDir is the exe directory when PORTABLE_EXECUTABLE_DIR is absent', () => {
    assert.equal(metricsBaseDir({}, '/opt/smartssh/smartssh.exe', 'linux'), '/opt/smartssh')
    assert.equal(metricsBaseDir({ PORTABLE_EXECUTABLE_DIR: '/media/usb/smartssh' }, '/opt/x.exe', 'linux'), '/media/usb/smartssh')
})

test('a host without execPath and without PORTABLE_EXECUTABLE_DIR fails loudly', () => {
    assert.throws(() => resolveMetricsPath({}, '', 'linux'), /execPath/)
    assert.throws(() => metricsBaseDir({}, '   ', 'linux'), /execPath/)
})

// ---------------------------------------------------------------- override

test('SMARTSSH_MEASURE_PATH absolute wins outright', () => {
    const out = resolveMetricsPath(
        { [MEASURE_PATH_ENV]: '/var/tmp/smartssh/metrics.json', PORTABLE_EXECUTABLE_DIR: '/opt/smartssh' },
        '/opt/smartssh/smartssh.exe',
        'linux')
    assert.equal(out, '/var/tmp/smartssh/metrics.json')
})

test('SMARTSSH_MEASURE_PATH relative is rooted at the exe dir, not cwd', () => {
    withCwd(CWD_A, () => {
        const out = resolveMetricsPath({ [MEASURE_PATH_ENV]: 'out/metrics.json' }, '/opt/smartssh/smartssh.exe', 'linux')
        assert.equal(out, '/opt/smartssh/out/metrics.json')
        assert.equal(path.posix.isAbsolute(out), true)
    })
})

test('blank SMARTSSH_MEASURE_PATH is ignored (falls back to the default)', () => {
    assert.equal(resolveMetricsPath({ [MEASURE_PATH_ENV]: '   ' }, '/opt/smartssh/smartssh.exe', 'linux'),
        '/opt/smartssh/data/metrics.json')
})

// ---------------------------------------------------------------- repo-wide name consistency
// The contract permits exactly the recording switch, output path, and live window case selector.
// Reject every other spelling so code and documentation cannot silently drift.
test('only the three canonical measurement env names survive under smartssh/ or tabby-terminal/src/', () => {
    const ROOTS = [join(REPO_ROOT, 'smartssh'), join(REPO_ROOT, 'tabby-terminal', 'src')]
    const ALLOWED = new Set([MEASURE_ENV, MEASURE_PATH_ENV, `${MEASURE_ENV}_CASE`])
    // Assembled from parts so this file does not match its own pattern.
    const RE = new RegExp(`SMARTSSH_(?:${'MEASURE'}|${'METRICS'})[A-Z_]*`, 'g')
    const found = new Map()

    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
            const full = join(dir, entry.name)
            if (entry.isDirectory()) { walk(full); continue }
            if (!entry.isFile()) continue
            let text
            try { text = fs.readFileSync(full, 'utf8') } catch { continue }
            for (const match of text.matchAll(RE)) {
                if (!found.has(match[0])) found.set(match[0], path.relative(REPO_ROOT, full).split(path.sep).join('/'))
            }
        }
    }
    for (const root of ROOTS) walk(root)

    const names = [...found.keys()].sort()
    const unexpected = names.filter(name => !ALLOWED.has(name))
    assert.deepEqual(unexpected, [], `unexpected env spellings: ${unexpected.map(n => `${n} (${found.get(n)})`).join(', ')}`)
    assert.equal(names.length, ALLOWED.size, `found ${names.length} names: ${names.join(', ')}`)
})

for (const dir of [CWD_A, CWD_B]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort cleanup */ }
}

console.log(`${total - fails}/${total} passed`)
process.exit(fails ? 1 : 0)
