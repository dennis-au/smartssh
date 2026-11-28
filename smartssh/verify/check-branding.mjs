#!/usr/bin/env node
/**
 * smartssh/verify/check-branding.mjs — the SmartSSH source gate for upstream brand residue.
 *
 * `productName`/`appId`/icon were renamed to Smart SSH, but the app UI still said "Tabby" in the
 * Welcome page, the About box, dialogs and the window-title fallbacks. A one-off sweep rots, so the
 * rule is executable: every `Tabby` in `app/**` and `tabby-*\src\**` must be either user-facing text
 * (which must be fixed) or a whitelisted identifier/provenance (see `brandingRules.mjs`).
 *
 * Usage:
 *   node smartssh/verify/check-branding.mjs              # scan the repo (default root)
 *   node smartssh/verify/check-branding.mjs --root <dir> # scan another tree (tests use this)
 *   node smartssh/verify/check-branding.mjs --json       # machine output on stdout
 *
 * Exit codes: 0 = no user-facing hit, 1 = at least one hit (or nothing was scanned), 2 = bad usage.
 *
 * The scan is fail-closed on an empty file set: a gate that scans zero files always "passes", which
 * is exactly the run-19 failure one level up.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BRAND, SCAN_EXTENSIONS, REPLACEMENT, findBrandingHits } from './brandingRules.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..', '..')

/** Directories that hold user-visible app code. */
const APP_ROOTS = ['app/src', 'app/lib']
/** Single files next to the app roots that also render. */
const APP_FILES = ['app/index.pug']

const USAGE = `usage: node smartssh/verify/check-branding.mjs [--root <dir>] [--json]

  --root <dir>  tree to scan (default: this repo)
  --json        print {"ok","scannedFiles","hits"} on stdout`

function walk (dir, found) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full, found)
        else if (entry.isFile() && SCAN_EXTENSIONS.includes(path.extname(entry.name))) found.push(full)
    }
    return found
}

/** Every file the gate owns: app sources plus each plugin's `src/`. */
export function collectFiles (root) {
    const files = []
    for (const rel of APP_ROOTS) {
        const dir = path.join(root, rel)
        if (fs.existsSync(dir)) walk(dir, files)
    }
    for (const rel of APP_FILES) {
        const file = path.join(root, rel)
        if (fs.existsSync(file)) files.push(file)
    }
    let topLevel = []
    try {
        topLevel = fs.readdirSync(root, { withFileTypes: true })
    } catch {
        topLevel = []
    }
    for (const entry of topLevel) {
        if (!entry.isDirectory() || !/^tabby-/.test(entry.name)) continue
        const dir = path.join(root, entry.name, 'src')
        if (fs.existsSync(dir)) walk(dir, files)
    }
    return [...new Set(files)].sort()
}

function relPath (root, file) {
    return path.relative(root, file).split(path.sep).join('/')
}

function parseArgs (argv) {
    const options = { root: DEFAULT_ROOT, json: false }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === '--json') options.json = true
        else if (arg === '--root') {
            options.root = path.resolve(argv[++i] ?? '')
            if (!argv[i]) throw new Error('--root needs a directory')
        } else if (arg.startsWith('--root=')) options.root = path.resolve(arg.slice('--root='.length))
        else throw new Error(`unknown argument ${JSON.stringify(arg)}`)
    }
    return options
}

export function scan (root) {
    const files = collectFiles(root)
    const hits = []
    for (const file of files) {
        hits.push(...findBrandingHits(fs.readFileSync(file, 'utf8'), { file: relPath(root, file) }))
    }
    return { scannedFiles: files.length, hits }
}

function main () {
    let options
    try {
        options = parseArgs(process.argv.slice(2))
    } catch (error) {
        process.stderr.write(`${error.message}\n${USAGE}\n`)
        return 2
    }

    if (!fs.existsSync(options.root)) {
        process.stderr.write(`check-branding: --root ${options.root} does not exist\n`)
        return 2
    }

    const { scannedFiles, hits } = scan(options.root)
    const ok = scannedFiles > 0 && hits.length === 0

    if (options.json) {
        process.stdout.write(JSON.stringify({ ok, scannedFiles, hits }) + '\n')
    } else {
        for (const hit of hits) {
            process.stdout.write(`${hit.file}:${hit.line}:${hit.col}: user-facing "${BRAND}" (use "${REPLACEMENT}") — ${hit.text}\n`)
        }
        if (scannedFiles === 0) {
            process.stdout.write(`check-branding: FAILED — nothing under app/src, app/lib or tabby-*/src was scanned (${options.root})\n`)
        } else if (hits.length === 0) {
            process.stdout.write(`check-branding: ${scannedFiles} files scanned, 0 user-facing "${BRAND}" hits\n`)
        } else {
            const files = new Set(hits.map((hit) => hit.file)).size
            process.stdout.write(`check-branding: FAILED — ${hits.length} user-facing "${BRAND}" hit(s) in ${files} of ${scannedFiles} scanned files\n`)
        }
    }

    return ok ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    process.exitCode = main()
}
