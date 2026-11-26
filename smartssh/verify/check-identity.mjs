#!/usr/bin/env node
// smartssh/verify/check-identity.mjs — proves the shipped portable build carries SmartSSH identity,
// not Tabby's, and that a portable launch redirects userData before Electron reads it.
//
// Reads the *effective* config: electron-builder.yml merged with the overrides in
// scripts/build-smartssh.mjs (electron-builder deep-merges the programmatic config over the yml).
// No dependencies: the yml is parsed for the few keys involved, nothing else is interpreted.
//
// Exit 0 = all checks pass, 1 = at least one FAIL. Every check prints what it measured.
//
// Note on app/src/entry.ts: that file is the *renderer* entry, not the main process. The executable
// redirect therefore lives in app/lib/portable.ts (real app.setPath call), imported by
// app/lib/index.ts before anything reads userData; entry.ts is checked for the renderer-side mirror.
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as url from 'node:url'

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..')
const P = (...p) => path.join(ROOT, ...p)

const results = []
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail })
const read = rel => fs.readFileSync(P(rel), 'utf8')
const exists = rel => fs.existsSync(P(rel))

export const EXPECTED = Object.freeze({
    productName: 'Smart SSH',
    appId: 'com.smartssh.app',
    artifactPrefix: 'smartssh-',
})

/** Minimal reader for the top-level keys and the `win:` block of electron-builder.yml. */
export function parseBuilderYml (text) {
    const out = { top: {}, win: {}, hasSignExts: false, hasSigning: false }
    let section = null
    for (const rawLine of text.split(/\r?\n/)) {
        if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue
        const indent = rawLine.length - rawLine.trimStart().length
        const line = rawLine.trim()
        const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
        if (!kv) continue
        const [, key, valueRaw] = kv
        const value = valueRaw.replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '')
        if (indent === 0) {
            section = value === '' ? key : null
            out.top[key] = value
        } else if (section === 'win') {
            out.win[key] = value
            if (key === 'signExts') out.hasSignExts = true
            if (key === 'signtoolOptions') out.hasSigning = true
        }
    }
    return out
}

/** Pull the overrides out of the `config: { ... }` block of scripts/build-smartssh.mjs. */
export function parseOverride (text) {
    const start = text.indexOf('config: {')
    const body = start === -1 ? '' : text.slice(start)
    const grab = re => { const m = re.exec(body); return m ? m[1] : null }
    return {
        productName: grab(/productName:\s*["']([^"']+)["']/),
        appId: grab(/appId:\s*["']([^"']+)["']/),
        winArtifactName: grab(/artifactName:\s*["']([^"']+)["']/),
        // `signtoolOptions: undefined` in the override means "do not sign the portable exe".
        signtoolDisabled: /signtoolOptions:\s*undefined/.test(body),
    }
}

function main () {
    const yml = parseBuilderYml(read('electron-builder.yml'))
    const ov = parseOverride(read('scripts/build-smartssh.mjs'))

    const effectiveProductName = ov.productName ?? yml.top.productName
    const effectiveAppId = ov.appId ?? yml.top.appId
    const effectiveArtifact = ov.winArtifactName ?? yml.win.artifactName ?? ''

    check('productName is Smart SSH', effectiveProductName === EXPECTED.productName,
        `effective=${JSON.stringify(effectiveProductName)} yml=${JSON.stringify(yml.top.productName)} override=${JSON.stringify(ov.productName)}`)
    check('appId is com.smartssh.app', effectiveAppId === EXPECTED.appId,
        `effective=${JSON.stringify(effectiveAppId)} yml=${JSON.stringify(yml.top.appId)} override=${JSON.stringify(ov.appId)}`)
    check('portable artifactName starts with smartssh-', effectiveArtifact.startsWith(EXPECTED.artifactPrefix),
        `effective=${JSON.stringify(effectiveArtifact)}`)
    check("artifactName still carries ${version} and ${arch}", /\$\{version\}/.test(effectiveArtifact) && /\$\{(arch|env\.ARCH)\}/.test(effectiveArtifact),
        `effective=${JSON.stringify(effectiveArtifact)}`)
    check('identity is not Tabby', !/tabby/i.test(String(effectiveProductName)) && !/tabby/i.test(String(effectiveAppId)),
        `productName=${JSON.stringify(effectiveProductName)} appId=${JSON.stringify(effectiveAppId)}`)

    // Icon: deliberately inherited from the yml (artwork is an operator decision, not a script one).
    const icon = yml.win.icon ?? ''
    check('win.icon is inherited from the yml and exists on disk', icon !== '' && exists(icon.replace(/^\.\//, '')),
        `win.icon=${JSON.stringify(icon)} exists=${icon !== '' && exists(icon.replace(/^\.\//, ''))}`)

    // Boundaries from the card: the tabby build's nsis/signing/compression behaviour must survive.
    check('compression untouched (normal)', yml.top.compression === 'normal', `compression=${JSON.stringify(yml.top.compression)}`)
    check('signExts still present', yml.hasSignExts, `signExts=${yml.hasSignExts}`)
    check('signtoolOptions still present in yml', yml.hasSigning, `signtoolOptions=${yml.hasSigning}`)
    check('portable build keeps signing disabled', ov.signtoolDisabled, `signtoolOptions: undefined=${ov.signtoolDisabled}`)

    // --- portable userData redirect -------------------------------------------------------
    const entry = read('app/src/entry.ts')
    check('entry.ts mentions PORTABLE_EXECUTABLE_DIR', entry.includes('PORTABLE_EXECUTABLE_DIR'),
        `hits=${(entry.match(/PORTABLE_EXECUTABLE_DIR/g) ?? []).length}`)
    check('entry.ts references app.setPath(\'userData\')', entry.includes("app.setPath('userData'"),
        `hits=${(entry.match(/app\.setPath\('userData'/g) ?? []).length}`)

    const portableTs = read('app/lib/portable.ts')
    const realCall = /electron\.app\.setPath\('userData',\s*resolution\.path\)/.test(portableTs)
    check('main process performs the redirect (app/lib/portable.ts: app.setPath userData)', realCall,
        `app.setPath('userData', resolution.path)=${realCall}`)
    check('main process reads PORTABLE_EXECUTABLE_DIR', /process\.env\.PORTABLE_EXECUTABLE_DIR/.test(portableTs),
        'process.env.PORTABLE_EXECUTABLE_DIR')
    check('main process probes writability before choosing the dir', /probeWritableDir\(portableRoot\)/.test(portableTs),
        'probeWritableDir(portableRoot)')
    check('main process uses the tested resolver module', /from '\.\.\/\.\.\/smartssh\/app\/portablePath\.mjs'/.test(portableTs),
        'import ... from ../../smartssh/app/portablePath.mjs')
    check('every mkdir targets the resolved path (never the raw portable root)',
        (() => {
            const calls = portableTs.match(/mkdirSync\([^)]*\)/g) ?? []
            return calls.length > 0 && calls.every(c => c.startsWith('mkdirSync(resolution.path'))
        })(),
        `mkdirSync calls=${JSON.stringify(portableTs.match(/mkdirSync\([^)]*\)/g) ?? [])}`)

    // Ordering: ./portable must be imported before anything reads userData in the main entry.
    const index = read('app/lib/index.ts')
    const importLine = index.split(/\r?\n/).findIndex(l => /^import '\.\/portable'$/.test(l.trim()))
    const firstReadLine = index.split(/\r?\n/).findIndex(l => /app\.getPath\('userData'\)/.test(l))
    check("index.ts imports './portable' before the first getPath('userData')",
        importLine !== -1 && firstReadLine !== -1 && importLine < firstReadLine,
        `import line=${importLine + 1} first getPath=${firstReadLine + 1}`)

    // The resolver must stay Electron-free so it can be unit-tested off-Windows.
    const resolver = read('smartssh/app/portablePath.mjs')
    check('portablePath.mjs does not import electron', !/from\s+['"]electron['"]/.test(resolver),
        'no electron import')
    check('portablePath.mjs exports resolveUserDataPath', /export function resolveUserDataPath/.test(resolver),
        'export function resolveUserDataPath')
    check('read-only branch does not fall back to the userData path',
        !/readOnlyMode:\s*true[\s\S]{0,200}fallbackUserData/.test(resolver),
        'no fallbackUserData in the read-only branch')
    // The checklist denies CreateFiles but not subdirectory creation: a mkdir probe would leave
    // <portable>/data behind on a read-only medium and fail windows-checklist.ps1 item 2.
    check('write probe is a file probe, not mkdir(<portable>/data)',
        /writeFileSync\(probe/.test(resolver) && !/mkdirSync/.test(resolver),
        'writeFileSync probe, no mkdirSync')

    for (const r of results) {
        console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  [${r.detail}]`)
    }
    const failed = results.filter(r => !r.ok)
    console.log(`\n${results.length - failed.length}/${results.length} identity checks passed`)
    console.log(`effective: productName=${JSON.stringify(effectiveProductName)} appId=${JSON.stringify(effectiveAppId)} artifactName=${JSON.stringify(effectiveArtifact)}`)
    if (failed.length) {
        console.log('FAILED: ' + failed.map(f => f.name).join('; '))
        process.exit(1)
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url))) {
    main()
}
