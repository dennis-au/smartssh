#!/usr/bin/env node
/**
 * SmartSSH single test entry point.
 *
 * Discovers every SmartSSH test file (`smartssh/**\/*.test.mjs` plus
 * `smartssh/core/selftest.mjs`), spawns `node <file>` for each one in turn, and
 * fails loudly on the first non-zero exit instead of hand-listing a subset in CI.
 *
 * Usage:
 *   node smartssh/verify/test-all.mjs            # human output
 *   node smartssh/verify/test-all.mjs --json     # machine output (single JSON object on stdout)
 *
 * Exit codes:
 *   0  every discovered test file exited 0
 *   2  at least one test file exited non-zero (or nothing was discovered)
 *   3  dependencies are missing — tests were NOT run and NOT skipped-as-pass
 *
 * Env:
 *   SMARTSSH_TEST_TIMEOUT_MS  per-file timeout, default 300000 (5 min)
 */
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERIFY_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(VERIFY_DIR, '..', '..')
const SMARTSSH_DIR = join(REPO_ROOT, 'smartssh')

/** Module that three core tests import directly; nothing runs (or "passes") without it. */
const DEP_MODULE = '@xterm/headless'
const INSTALL_HINT = 'install deps first: (cd app && yarn) && yarn'

const EXIT_OK = 0
const EXIT_FAILED = 2
const EXIT_DEPS = 3

const TAIL_LINES = 25
const OUTPUT_CHARS = 8192
/** Per-failure excerpt published in --json (`failures[].tail`) and in ci-status/<run>.json. */
const FAILURE_TAIL_CHARS = 2000
const FILE_TIMEOUT_MS = Number(process.env.SMARTSSH_TEST_TIMEOUT_MS) || 300_000

const USAGE = `usage: node smartssh/verify/test-all.mjs [--json] [--help]

  --json   print {"files","passed","failed","durationMs","failures"} on stdout (progress goes to stderr);
           failures[] carries { file, exitCode, tail } so a credential-free reader can name the file
  --help   show this message`

/** `x.test.mjs` anywhere under smartssh/, plus smartssh/core/selftest.mjs. */
function isTestFile (name) {
  return name.endsWith('.test.mjs') || name === 'selftest.mjs'
}

function walk (dir, found) {
  const entries = readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, found)
    else if (entry.isFile() && isTestFile(entry.name)) found.push(full)
  }
  return found
}

/** Repo-relative path with forward slashes, so Windows CI output matches POSIX. */
function relPath (absPath) {
  return relative(REPO_ROOT, absPath).split(sep).join('/')
}

/** Absolute paths of every test file, sorted for a stable run order. */
function discoverTests () {
  return walk(SMARTSSH_DIR, []).sort((a, b) => relPath(a).localeCompare(relPath(b)))
}

/**
 * Resolve the dep exactly the way a test file in smartssh/core would, so the
 * gate matches reality (hoisted root node_modules, NODE_PATH, ...).
 */
function depsInstalled () {
  try {
    createRequire(join(SMARTSSH_DIR, 'core', 'probe.cjs')).resolve(DEP_MODULE)
    return true
  } catch {
    return false
  }
}

/** Run one file, capturing exit code and the last few lines of its output. */
function runFile (absPath) {
  return new Promise((resolvePromise) => {
    const started = Date.now()
    const child = spawn(process.execPath, [absPath], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let output = ''
    let timedOut = false
    const collect = (chunk) => {
      output = (output + chunk.toString('utf8')).slice(-OUTPUT_CHARS)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, FILE_TIMEOUT_MS)

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const tail = output.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0)
      const exitCode = timedOut ? 'timeout' : (code ?? signal ?? 'signal')
      resolvePromise({
        file: relPath(absPath),
        code: exitCode,
        ok: !timedOut && code === 0,
        durationMs: Date.now() - started,
        tail: tail.slice(-TAIL_LINES),
        // Raw character tail: the machine-readable answer to "which file failed, and why".
        outputTail: output.slice(-FAILURE_TAIL_CHARS),
      })
    })
  })
}

function seconds (ms) {
  return `${(ms / 1000).toFixed(2)}s`
}

async function main () {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE + '\n')
    return EXIT_OK
  }
  for (const arg of args.filter((a) => a !== '--json')) {
    process.stderr.write(`test-all: ignoring unknown argument ${JSON.stringify(arg)}\n`)
  }

  // Progress must never pollute the --json stdout payload.
  const log = json ? (s) => process.stderr.write(s + '\n') : (s) => process.stdout.write(s + '\n')

  const files = discoverTests()
  const total = files.length
  if (total === 0) {
    process.stdout.write(`test-all: no test files discovered under ${relative(process.cwd(), SMARTSSH_DIR) || SMARTSSH_DIR}\n`)
    return EXIT_FAILED
  }

  if (!depsInstalled()) {
    // Nothing ran, so nothing can be reported as a per-file tail: every discovered file is listed
    // with the install hint instead of an invented failure excerpt.
    const payload = {
      files: total,
      passed: 0,
      failed: total,
      durationMs: 0,
      failures: files.map((file) => ({ file: relPath(file), exitCode: 'deps-missing', tail: INSTALL_HINT })),
    }
    if (json) {
      // Keep stdout pure JSON; the hint still has to be visible somewhere.
      process.stderr.write(INSTALL_HINT + '\n')
      process.stdout.write(JSON.stringify(payload) + '\n')
    } else {
      process.stdout.write(INSTALL_HINT + '\n')
    }
    return EXIT_DEPS
  }

  log(`SmartSSH test-all: ${total} files`)

  const started = Date.now()
  const results = []
  for (const [index, file] of files.entries()) {
    const result = await runFile(file)
    results.push(result)
    const label = `[${String(index + 1).padStart(2)}/${total}]`
    log(`${label} ${result.ok ? 'PASS' : 'FAIL'} ${result.file} (${seconds(result.durationMs)})`)
    if (!result.ok) {
      for (const line of result.tail) log(`         | ${line}`)
    }
  }
  const durationMs = Date.now() - started

  const failed = results.filter((r) => !r.ok)
  const passed = total - failed.length

  if (json) {
    process.stdout.write(JSON.stringify({
      files: total,
      passed,
      failed: failed.length,
      durationMs,
      failures: failed.map((r) => ({ file: r.file, exitCode: r.code, tail: r.outputTail })),
    }) + '\n')
  } else {
    if (failed.length > 0) {
      log('')
      log(`FAILED (${failed.length}):`)
      for (const f of failed) {
        log(`  ${f.file} -> exit ${f.code}`)
        for (const line of f.tail) log(`    | ${line}`)
      }
    }
    log('')
    log(`${passed}/${total} test files passed in ${seconds(durationMs)}`)
  }

  return failed.length === 0 ? EXIT_OK : EXIT_FAILED
}

main().then(
  (code) => { process.exitCode = code },
  (err) => {
    process.stderr.write(`test-all: runner crashed: ${err && err.stack ? err.stack : err}\n`)
    process.exitCode = EXIT_FAILED
  },
)
