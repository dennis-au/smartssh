// smartssh/verify/check-branding.test.mjs — the brand gate has to fail on residue, or it is
// decoration. This file is the aggregate-gate entry for `check-branding.mjs`: `test-all.mjs`
// discovers it like any other test, it drives the real script as a subprocess (never a reimplemented
// copy of the rules), and it asserts both directions on throwaway fixtures:
//
//   - a user-facing `Tabby` in a .pug/.ts/.html/.scss-neighbour file exits 1 and prints `path:line`
//   - provenance and identifiers (npm scope, upstream URL, copyright, code symbols, registry keys,
//     `.workflow` resource names, comments) exit 0
//   - a tree with nothing to scan exits 1 instead of "passing" vacuously
//
// It also runs the script against this repo, so the real Welcome/About/title strings stay fixed.
//
// Run: node smartssh/verify/check-branding.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = path.join(REPO_ROOT, 'smartssh', 'verify', 'check-branding.mjs')

const r = []
const t = (name, fn) => {
    try {
        fn()
        r.push(['PASS', name])
    } catch (error) {
        r.push(['FAIL', name + ' :: ' + error.message])
    }
}

const fixtures = []
function makeFixture (files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartssh-branding-'))
    fixtures.push(root)
    for (const [rel, content] of Object.entries(files)) {
        const target = path.join(root, rel)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, content)
    }
    return root
}

function run (root, extraArgs = []) {
    const args = [SCRIPT, ...(root ? ['--root', root] : []), ...extraArgs]
    const result = spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf-8' })
    return {
        code: result.status,
        stdout: result.stdout ?? '',
        output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    }
}

try {
    // ------------------------------------------------------------------- this repo must stay clean
    t('the real repo has no user-facing "Tabby" left', () => {
        const { code, stdout } = run(null)
        assert.equal(code, 0, `check-branding exited ${code}: ${stdout}`)
        assert.match(stdout, /0 user-facing "Tabby" hits/)
    })
    t('the real repo scan is not vacuous (hundreds of files, not zero)', () => {
        const { stdout } = run(null)
        const scanned = Number((/check-branding: (\d+) files scanned/.exec(stdout) ?? [])[1])
        assert.ok(scanned > 100, `only ${scanned} files scanned — the walk is broken`)
    })

    // ---------------------------------------------------------------------------- residue fails
    t('a Welcome title in .pug fails and names path:line', () => {
        const root = makeFixture({ 'app/src/welcome.component.pug': 'h1.tabby-title Tabby\n' })
        const { code, output } = run(root)
        assert.equal(code, 1)
        assert.match(output, /app\/src\/welcome\.component\.pug:1:\d+: user-facing "Tabby"/)
    })
    t('a dialog string in .ts fails', () => {
        const root = makeFixture({
            'app/lib/index.ts': "dialog.showErrorBox('Tabby failed to start', String(err))\n",
        })
        const { code, output } = run(root)
        assert.equal(code, 1)
        assert.match(output, /app\/lib\/index\.ts:1:\d+/)
    })
    t('an .html title fails', () => {
        const root = makeFixture({ 'app/src/index.html': '<html><title>Tabby</title></html>\n' })
        const { code, output } = run(root)
        assert.equal(code, 1)
        assert.match(output, /app\/src\/index\.html:1:\d+/)
    })
    t('a plugin under tabby-*/src is scanned too', () => {
        const root = makeFixture({ 'tabby-terminal/src/colorSchemes.ts': "name: 'Tabby Default',\n" })
        const { code, output } = run(root)
        assert.equal(code, 1)
        assert.match(output, /tabby-terminal\/src\/colorSchemes\.ts:1:\d+/)
    })
    t('the identifier whitelist is not line-wide: a class next to a label still fails', () => {
        const root = makeFixture({
            'app/src/plugin.ts': "export class TabbyCorePlugin {}\nconst label = 'About Tabby'\n",
        })
        const { code, output } = run(root)
        assert.equal(code, 1)
        assert.match(output, /plugin\.ts:2:\d+/, 'the display string on line 2 must be reported')
        assert.equal(/plugin\.ts:1:/.test(output), false, 'the TabbyCorePlugin symbol must stay whitelisted')
    })

    // ------------------------------------------------------------------------ provenance passes
    t('provenance and identifiers are whitelisted', () => {
        const root = makeFixture({
            'app/src/provenance.ts': [
                "import core from '@tabby-gang/core'",
                "import plugin from 'tabby-core'",
                "export const upstream = 'https://github.com/EugenePamyatnykh/tabby'",
                '// Behaviour kept from upstream Tabby: portable userData redirect',
                '/* Copyright (c) 2020 Tabby contributors */',
                'export class TabbyCorePlugin {}',
                "export const workflow = 'Open Tabby here.workflow'",
                '',
            ].join('\n'),
            'tabby-electron/src/registry.ts': String.raw`export const key = 'Software\\Classes\\Directory\\Background\\shell\\Tabby'` + '\n',
        })
        const { code, output } = run(root)
        assert.equal(code, 0, output)
    })
    t('a whitelisted identifier does not whitelist a different hit on the same line', () => {
        const root = makeFixture({
            'app/src/mixed.ts': "const x = TabbyCorePlugin; tray.setToolTip('Tabby')\n",
        })
        const { code } = run(root)
        assert.equal(code, 1)
    })

    // ------------------------------------------------------------------------------ fail-closed
    t('a tree with nothing to scan fails instead of passing vacuously', () => {
        const root = makeFixture({ 'README.md': 'nothing to see here\n' })
        const { code, output } = run(root)
        assert.equal(code, 1)
        assert.match(output, /FAILED — nothing under app\/src, app\/lib or tabby-\*\/src was scanned/)
    })

    // -------------------------------------------------------------------------------- machine API
    t('--json reports ok/scannedFiles/hits with a repo-relative file', () => {
        const root = makeFixture({ 'app/src/welcome.component.pug': 'h1 Tabby\n' })
        const { code, stdout } = run(root, ['--json'])
        assert.equal(code, 1)
        const report = JSON.parse(stdout)
        assert.equal(report.ok, false)
        assert.equal(report.scannedFiles, 1)
        assert.equal(report.hits.length, 1)
        assert.equal(report.hits[0].file, 'app/src/welcome.component.pug')
        assert.equal(report.hits[0].line, 1)
        assert.equal(stdout.includes(root), false, 'the JSON must not leak the absolute fixture path')
    })

    // ------------------------------------------------------------------------------ usage errors
    t('a missing --root is a usage error (exit 2)', () => {
        const { code } = run(path.join(os.tmpdir(), 'smartssh-branding-does-not-exist'))
        assert.equal(code, 2)
    })
    t('an unknown argument is a usage error (exit 2)', () => {
        const root = makeFixture({ 'app/src/a.ts': '\n' })
        const { code } = run(root, ['--nonsense'])
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
