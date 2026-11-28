#!/usr/bin/env node
/**
 * Packaging self-check for the SmartSSH portable exe.
 *
 * Why this exists: run 19 shipped an exe with no plugins at all. `electron-builder.yml` declares
 * `extraResources: builtin-plugins`, and electron-builder skips an `extraResources` directory that
 * does not exist *silently* — so the job stayed green while `resources/builtin-plugins` was absent.
 * `app/src/app.module.ts` then throws "Did not find any bootstrap components. Are there any plugins
 * installed?", no terminal plugin loads, and `data/metrics.json` can never be written.
 *
 * This script turns "the plugins are missing" into a failed build instead of a quiet omission, and
 * writes a machine-readable report that the status step publishes inside `ci-status/<run>.json`, so
 * a verifier with no token can read the packaging result straight from the branch.
 *
 * Usage:
 *   node scripts/verify-packaging.mjs --stage=staged     # ./builtin-plugins (before electron-builder)
 *   node scripts/verify-packaging.mjs --stage=packaged   # dist/<name>-unpacked/resources/builtin-plugins + exe
 *
 * Exit codes: 0 = every required check passed, 1 = at least one failed, 2 = bad usage.
 *
 * The report is world-readable (public repo): repo-relative paths only — no runner name, no OS
 * build, no absolute path, no timestamp.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { findBrandingHits } from '../smartssh/verify/brandingRules.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The three plugins the acceptance contract names; every one must be loadable. */
const REQUIRED_PLUGINS = ['tabby-core', 'tabby-settings', 'tabby-terminal']

/** `builtinPlugins` in scripts/vars.mjs minus `tabby-web`, which prepackage-plugins.mjs skips. */
const EXPECTED_PLUGIN_COUNT = 12

/**
 * Symbols that must be in the *shipped* tabby-terminal bundle. Each one is a feature that was
 * absent from run 19: `xterm` (the terminal itself), `smartssh-bar` (the Angular selector), and
 * `SMARTSSH_MEASURE` (the metrics switch, whose literal lives in smartssh/app/metricsPath.mjs and
 * is bundled through baseTerminalTab.component.ts).
 */
const REQUIRED_SYMBOLS = ['xterm', 'smartssh-bar', 'SMARTSSH_MEASURE']

/** Recorded, never required: extra evidence that the SmartSSH wiring came along. */
const INFORMATIONAL_SYMBOLS = ['createProposalService', 'barModel', 'metrics.json']

const checks = []

function check (name, ok, detail) {
    checks.push({ name, ok: !!ok, detail: String(detail) })
    return ok
}

function countSymbols (file, symbols) {
    const data = fs.readFileSync(file)
    const counts = {}
    for (const symbol of symbols) {
        const needle = Buffer.from(symbol)
        let count = 0
        let at = data.indexOf(needle)
        while (at !== -1) {
            count++
            at = data.indexOf(needle, at + needle.length)
        }
        counts[symbol] = count
    }
    return counts
}

/** Reads `<pluginDir>/package.json` and returns it, or null with a failed check recorded. */
function readPluginInfo (pluginsDir, plugin) {
    const infoPath = path.join(pluginsDir, plugin, 'package.json')
    const rel = path.relative(repoRoot, infoPath).split(path.sep).join('/')
    if (!check(`${plugin}/package.json`, fs.existsSync(infoPath), fs.existsSync(infoPath) ? rel : `missing ${rel}`)) {
        return null
    }
    let info
    try {
        info = JSON.parse(fs.readFileSync(infoPath, 'utf-8'))
    } catch (error) {
        check(`${plugin}/package.json parses`, false, String(error.message))
        return null
    }
    check(`${plugin}/package.json parses`, true, `name=${info.name} version=${info.version}`)

    // app/src/plugins.ts drops a package whose keywords do not mark it as a builtin plugin, so a
    // staged copy that lost its keywords would look present and still boot with zero plugins.
    const keywords = Array.isArray(info.keywords) ? info.keywords : []
    check(`${plugin}/keywords`, keywords.includes('tabby-builtin-plugin') || keywords.includes('tabby-plugin'),
        JSON.stringify(keywords))

    const main = typeof info.main === 'string' ? info.main : ''
    const mainPath = main ? path.join(pluginsDir, plugin, main) : ''
    check(`${plugin}/main exists`, !!mainPath && fs.existsSync(mainPath),
        mainPath ? path.relative(repoRoot, mainPath).split(path.sep).join('/') : 'no "main" in package.json')
    return info
}

function findUnpackedDir () {
    const dist = path.join(repoRoot, 'dist')
    if (!fs.existsSync(dist)) {
        return null
    }
    const candidates = fs.readdirSync(dist, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /unpacked/i.test(entry.name))
        .map(entry => path.join(dist, entry.name))
        .filter(dir => fs.existsSync(path.join(dir, 'resources')))
    return candidates.length ? candidates[0] : null
}

function findPortableExe () {
    const dist = path.join(repoRoot, 'dist')
    if (!fs.existsSync(dist)) {
        return null
    }
    const exes = fs.readdirSync(dist).filter(name => /portable.*\.exe$/i.test(name))
    return exes.length ? path.join(dist, exes[0]) : null
}

/** 7z payload signature, i.e. where the NSIS stub ends and the real application archive begins. */
const SEVEN_Z_MAGIC = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])

/**
 * Corroboration on the finished exe: an electron-builder portable target is an NSIS stub wrapping a
 * 7z payload, and 7-Zip's NSIS handler only shows the stub (4 entries, zero plugins — which is what
 * a naive `7z l exe` printed even for a good build). So carve the payload at the 7z signature into a
 * temporary file first, then list *that*. Recorded as SKIPPED when no 7-Zip is on PATH: the
 * win-unpacked check above is the fail-closed one, because it inspects exactly the tree that gets
 * packed.
 */
function listExePayload (exePath) {
    const data = fs.readFileSync(exePath)
    const offset = data.indexOf(SEVEN_Z_MAGIC)
    if (offset < 0) {
        return { error: 'no 7z payload signature in the exe' }
    }
    const carved = path.join(os.tmpdir(), `smartssh-payload-${process.pid}.7z`)
    fs.writeFileSync(carved, data.subarray(offset))
    try {
        const candidates = [process.env.SEVEN_ZIP, '7z', '7za', 'C:\\Program Files\\7-Zip\\7z.exe'].filter(Boolean)
        for (const tool of candidates) {
            let out
            try {
                out = execFileSync(tool, ['l', '-slt', carved], {
                    encoding: 'utf-8',
                    stdio: ['ignore', 'pipe', 'ignore'],
                    maxBuffer: 64 * 1024 * 1024,
                })
            } catch (error) {
                continue // try the next candidate; a missing 7-Zip is not a packaging failure
            }
            const names = out.split(/\r?\n/)
                .filter(line => line.startsWith('Path = '))
                .map(line => line.slice('Path = '.length).trim().replace(/\\/g, '/'))
                .filter(name => name && name !== carved)
            return {
                tool,
                payloadOffset: offset,
                entries: names.length,
                builtinPluginsEntries: names.filter(name => name.includes('resources/builtin-plugins/')).length,
                pluginPackages: REQUIRED_PLUGINS
                    .filter(plugin => names.includes(`resources/builtin-plugins/${plugin}/package.json`))
                    .map(plugin => `resources/builtin-plugins/${plugin}/package.json`),
            }
        }
        return { error: 'no 7-Zip binary found (SEVEN_ZIP, 7z, 7za, C:\\Program Files\\7-Zip\\7z.exe)' }
    } finally {
        try {
            fs.unlinkSync(carved)
        } catch (error) {
            // the temp file is 100+ MB; a failed cleanup must not fail the packaging check
        }
    }
}

function main () {
    const stageArg = process.argv.find(arg => arg.startsWith('--stage='))
    const stage = stageArg ? stageArg.slice('--stage='.length) : ''
    if (stage !== 'staged' && stage !== 'packaged') {
        console.error('usage: node scripts/verify-packaging.mjs --stage=staged|packaged')
        process.exit(2)
    }

    let pluginsDir
    if (stage === 'staged') {
        pluginsDir = path.join(repoRoot, 'builtin-plugins')
        check('builtin-plugins/ exists', fs.existsSync(pluginsDir), 'builtin-plugins')
    } else {
        const unpacked = findUnpackedDir()
        check('electron-builder unpacked dir', !!unpacked,
            unpacked ? path.relative(repoRoot, unpacked).split(path.sep).join('/') : 'no dist/*unpacked* with resources/')
        pluginsDir = unpacked ? path.join(unpacked, 'resources', 'builtin-plugins') : ''
        if (pluginsDir) {
            check('resources/builtin-plugins/ exists', fs.existsSync(pluginsDir),
                path.relative(repoRoot, pluginsDir).split(path.sep).join('/'))
            const asar = path.join(unpacked, 'resources', 'app.asar')
            check('resources/app.asar exists', fs.existsSync(asar),
                fs.existsSync(asar) ? `bytes=${fs.statSync(asar).size}` : 'missing')
        }
    }

    let symbols = {}
    if (pluginsDir && fs.existsSync(pluginsDir)) {
        const present = fs.readdirSync(pluginsDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && /^(tabby|terminus)-/.test(entry.name))
            .map(entry => entry.name)
            .sort()
        check('plugin count', present.length >= EXPECTED_PLUGIN_COUNT,
            `${present.length} dirs (expected >= ${EXPECTED_PLUGIN_COUNT}): ${present.join(',')}`)

        for (const plugin of REQUIRED_PLUGINS) {
            readPluginInfo(pluginsDir, plugin)
        }

        // The one file whose absence made run 19 featureless: the terminal bundle with the bar.
        const terminalBundle = path.join(pluginsDir, 'tabby-terminal', 'dist', 'index.js')
        const relBundle = path.relative(repoRoot, terminalBundle).split(path.sep).join('/')
        if (check('tabby-terminal/dist/index.js exists', fs.existsSync(terminalBundle), relBundle)) {
            const required = countSymbols(terminalBundle, REQUIRED_SYMBOLS)
            symbols = { file: relBundle, bytes: fs.statSync(terminalBundle).size, ...required, ...countSymbols(terminalBundle, INFORMATIONAL_SYMBOLS) }
            for (const symbol of REQUIRED_SYMBOLS) {
                check(`symbol ${symbol}`, required[symbol] > 0, `count=${required[symbol]}`)
            }
        }

        // Branding: `productName`/`appId` are Smart SSH, but the Welcome page, the About box and the
        // window-title fallbacks are compiled *into* these bundles from the plugin sources. The same
        // whitelist as `smartssh/verify/check-branding.mjs` decides what counts as user-facing, so
        // upstream provenance (npm scope, URLs, copyright, code symbols) cannot fail the build.
        const brandingBundles = {}
        for (const plugin of REQUIRED_PLUGINS) {
            const bundle = path.join(pluginsDir, plugin, 'dist', 'index.js')
            if (!fs.existsSync(bundle)) continue
            const rel = path.relative(repoRoot, bundle).split(path.sep).join('/')
            brandingBundles[plugin] = findBrandingHits(fs.readFileSync(bundle, 'utf8'), { file: rel })
        }
        const brandingCounts = Object.fromEntries(
            Object.entries(brandingBundles).map(([plugin, hits]) => [plugin, hits.length])
        )
        symbols = { ...symbols, branding: brandingCounts }
        const terminalBranding = brandingBundles['tabby-terminal']
        check('tabby-terminal bundle has 0 user-facing "Tabby" strings',
            terminalBranding !== undefined && terminalBranding.length === 0,
            terminalBranding === undefined
                ? 'tabby-terminal/dist/index.js is missing, so branding could not be read'
                : terminalBranding.length === 0
                    ? 'count=0'
                    : `${terminalBranding.length} hit(s): ${terminalBranding.slice(0, 5).map((hit) => `${hit.line}: ${hit.text.slice(0, 120)}`).join(' | ')}`)
    }

    let exe = null
    if (stage === 'packaged') {
        const exePath = findPortableExe()
        check('portable exe produced', !!exePath, exePath ? path.basename(exePath) : 'no dist/*portable*.exe')
        if (exePath) {
            const payload = listExePayload(exePath)
            exe = { file: path.basename(exePath), bytes: fs.statSync(exePath).size, payload }
            if (payload.error) {
                // Three-state, like windows-checklist.ps1: a missing 7-Zip is a SKIP, never a PASS.
                checks.push({
                    name: 'exe payload listing',
                    ok: true,
                    skipped: true,
                    detail: `SKIPPED: ${payload.error} (the win-unpacked check above stays fail-closed)`,
                })
            } else {
                check('exe payload carries builtin-plugins', payload.builtinPluginsEntries > 0,
                    `${payload.builtinPluginsEntries} entries under resources/builtin-plugins/ via ${payload.tool}, ${payload.entries} payload entries total`)
                check('exe payload carries the three plugin package.json files',
                    payload.pluginPackages.length === REQUIRED_PLUGINS.length,
                    payload.pluginPackages.join(',') || 'none')
            }
        }
    }

    const failed = checks.filter(entry => !entry.ok && !entry.skipped)
    const skipped = checks.filter(entry => entry.skipped)
    const report = {
        stage,
        ok: failed.length === 0,
        checks,
        symbols,
        exe,
    }
    fs.writeFileSync(path.join(repoRoot, 'packaging-report.json'), JSON.stringify(report, null, 2) + '\n')

    for (const entry of checks) {
        const status = entry.skipped ? 'SKIP' : entry.ok ? 'PASS' : 'FAIL'
        console.log(`${status}  ${entry.name}  ${entry.detail}`)
    }
    const counted = checks.length - skipped.length
    console.log(`${stage}: ${counted - failed.length}/${counted} checks passed` + (skipped.length ? `, ${skipped.length} skipped` : ''))
    if (failed.length) {
        console.error(`packaging self-check FAILED (${failed.length}): ${failed.map(entry => entry.name).join(', ')}`)
        process.exit(1)
    }
}

main()
