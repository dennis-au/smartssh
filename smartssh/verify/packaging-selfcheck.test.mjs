// smartssh/verify/packaging-selfcheck.test.mjs — the packaging gate must fail when the plugins are
// missing, or it is decoration.
//
// Why this file exists: run 19 shipped an exe with no `resources/builtin-plugins` at all, because
// electron-builder skips a missing `extraResources` directory silently. `scripts/verify-packaging.mjs`
// now runs inside the packaging step to make that a failed build. A gate that only ever prints PASS
// is the same failure one level up, so this file drives the real script against throwaway fixtures
// and asserts both directions: a correct tree passes, and every way the tree was wrong in run 19
// (no directory, no plugin, no keywords, no symbol) exits non-zero with the failing check named.
//
// It also pins the report's public-safety rule: the file is published inside ci-status/<run>.json on
// a public repo, so it must never contain an absolute path.
//
// Run: node smartssh/verify/packaging-selfcheck.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'verify-packaging.mjs')

/** scripts/vars.mjs `builtinPlugins` minus `tabby-web`; the gate requires at least this many. */
const ALL_PLUGINS = [
    'tabby-auto-sudo-password', 'tabby-community-color-schemes', 'tabby-core', 'tabby-electron',
    'tabby-linkifier', 'tabby-local', 'tabby-plugin-manager', 'tabby-serial', 'tabby-settings',
    'tabby-ssh', 'tabby-telnet', 'tabby-terminal',
]
const REQUIRED_PLUGINS = ['tabby-core', 'tabby-settings', 'tabby-terminal']

/** The three literals run 19's exe lacked; the fixture bundle carries all of them. */
const BUNDLE = 'var xterm = 1; var SMARTSSH_MEASURE = 1; var bar = "smartssh-bar";\n'

const r = []
const t = (name, fn) => { try { fn(); r.push(['PASS', name]) } catch (e) { r.push(['FAIL', name + ' :: ' + e.message]) } }

const fixtures = []

function writePlugin (pluginsDir, name, { keywords = ['tabby-builtin-plugin'] } = {}) {
    const dir = path.join(pluginsDir, name)
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name,
        version: '1.0.231-nightly.0',
        main: 'dist/index.js',
        keywords,
    }, null, 2))
    fs.writeFileSync(path.join(dir, 'dist', 'index.js'), BUNDLE)
}

/**
 * A throwaway repo shaped like the two stages the gate runs in: `builtin-plugins/` before
 * electron-builder, `dist/win-unpacked/resources/{app.asar,builtin-plugins}` after it, plus the
 * portable exe name the gate looks for.
 */
function makeFixture ({ stagedPlugins = true } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartssh-packaging-'))
    fixtures.push(root)

    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
    fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'verify-packaging.mjs'))

    const staged = path.join(root, 'builtin-plugins')
    if (stagedPlugins) {
        for (const name of ALL_PLUGINS) {
            writePlugin(staged, name)
        }
    }

    const resources = path.join(root, 'dist', 'win-unpacked', 'resources')
    fs.mkdirSync(resources, { recursive: true })
    fs.writeFileSync(path.join(resources, 'app.asar'), '')
    if (stagedPlugins) {
        fs.cpSync(staged, path.join(resources, 'builtin-plugins'), { recursive: true })
    }
    // Fixture only: the gate's job here is control flow, and no real artifact is implied.
    fs.writeFileSync(path.join(root, 'dist', 'smartssh-0.0.0-fixture-portable-x64.exe'), Buffer.alloc(1024))
    return root
}

function run (root, stage) {
    const args = [path.join(root, 'scripts', 'verify-packaging.mjs')]
    if (stage) {
        args.push(`--stage=${stage}`)
    }
    const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf-8' })
    const reportPath = path.join(root, 'packaging-report.json')
    const text = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf-8') : ''
    return {
        code: result.status,
        output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
        text,
        report: text ? JSON.parse(text) : null,
    }
}

try {
    // ---------------------------------------------------------------- positive: both stages pass
    const good = makeFixture()
    t('staged stage passes on a complete tree', () => {
        const { code, report } = run(good, 'staged')
        assert.equal(code, 0)
        assert.equal(report.ok, true)
        assert.equal(report.symbols.xterm > 0, true)
        assert.equal(report.symbols['smartssh-bar'] > 0, true)
        assert.equal(report.symbols.SMARTSSH_MEASURE > 0, true)
    })
    t('packaged stage passes on the packed tree', () => {
        const { code, report } = run(good, 'packaged')
        assert.equal(code, 0)
        assert.equal(report.stage, 'packaged')
        assert.equal(report.exe.file.endsWith('.exe'), true)
    })
    t('report is public-safe: no absolute path, no timestamp', () => {
        const { text } = run(good, 'packaged')
        assert.equal(text.includes(good), false, 'report leaked the absolute fixture path')
        assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text), false, 'report leaked a timestamp')
    })

    // ------------------------------------------- negative: the four ways run 19's tree was wrong
    t('missing builtin-plugins/ fails the staged stage', () => {
        const root = makeFixture({ stagedPlugins: false })
        const { code, report, output } = run(root, 'staged')
        assert.equal(code, 1)
        assert.equal(report.ok, false)
        assert.match(output, /FAIL {2}builtin-plugins\/ exists/)
    })
    t('a required plugin missing fails (tabby-terminal)', () => {
        const root = makeFixture()
        fs.rmSync(path.join(root, 'builtin-plugins', 'tabby-terminal'), { recursive: true, force: true })
        const { code, output } = run(root, 'staged')
        assert.equal(code, 1)
        assert.match(output, /tabby-terminal\/package\.json/)
    })
    t('a plugin without tabby-builtin-plugin keywords fails (the loader would drop it)', () => {
        const root = makeFixture()
        writePlugin(path.join(root, 'builtin-plugins'), 'tabby-core', { keywords: [] })
        const { code, output } = run(root, 'staged')
        assert.equal(code, 1)
        assert.match(output, /tabby-core\/keywords/)
    })
    t('a shipped bundle without SMARTSSH_MEASURE fails the packaged stage', () => {
        const root = makeFixture()
        const bundle = path.join(root, 'dist', 'win-unpacked', 'resources', 'builtin-plugins', 'tabby-terminal', 'dist', 'index.js')
        fs.writeFileSync(bundle, BUNDLE.replace(/SMARTSSH_MEASURE/g, 'SMARTSSH_MEASURX'))
        const { code, output, report } = run(root, 'packaged')
        assert.equal(code, 1)
        assert.equal(report.symbols.SMARTSSH_MEASURE, 0)
        assert.match(output, /symbol SMARTSSH_MEASURE/)
    })
    t('the packaged stage fails when electron-builder left no unpacked tree', () => {
        const root = makeFixture()
        fs.rmSync(path.join(root, 'dist', 'win-unpacked'), { recursive: true, force: true })
        const { code, output } = run(root, 'packaged')
        assert.equal(code, 1)
        assert.match(output, /electron-builder unpacked dir/)
    })

    // ------------------------------------------------------------------------------ usage contract
    t('no --stage is a usage error (exit 2), not a silent pass', () => {
        const { code } = run(makeFixture())
        assert.equal(code, 2)
    })
} finally {
    for (const root of fixtures) {
        fs.rmSync(root, { recursive: true, force: true })
    }
}

for (const [status, name] of r) console.log(`${status}  ${name}`)
const failed = r.filter((x) => x[0] === 'FAIL')
console.log(`\n${r.length - failed.length}/${r.length} passed`)
process.exit(failed.length ? 1 : 0)
