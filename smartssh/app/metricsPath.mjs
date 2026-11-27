// smartssh/app/metricsPath.mjs — where the UI measurement file (`data/metrics.json`) lives.
//
// Two contract holes kept `windows-checklist.ps1` at "UI metrics: SKIPPED" on every build:
//   * the switch documented by the measurement contract was not the one the code read, so an
//     operator following the documentation produced no file at all;
//   * the default path was the relative string 'data/metrics.json', so the file landed in whatever
//     the process cwd happened to be — while the checklist looks next to the exe it inspects.
//
// This module is the single answer to both: one switch name (SMARTSSH_MEASURE) with one path
// override (SMARTSSH_MEASURE_PATH), and a default path rooted at the portable/exe directory.
// cwd is never part of the answer.
//
// Pure: no Electron, no fs, no globals captured at import time — every argument is injected so
// each branch is unit-testable off-Windows.
import * as path from 'node:path'
import { normalizePortableDir } from './portablePath.mjs'

/** Recording switch. `SMARTSSH_MEASURE=1` is the only value that turns it on. */
export const MEASURE_ENV = 'SMARTSSH_MEASURE'
/** Optional explicit file path. Absolute wins outright; relative is rooted at the exe directory. */
export const MEASURE_PATH_ENV = 'SMARTSSH_MEASURE_PATH'
export const METRICS_DIR_NAME = 'data'
export const METRICS_FILE_NAME = 'metrics.json'
/** Documented location relative to the exe: `<exe dir>/data/metrics.json`. */
export const METRICS_RELATIVE_PATH = `${METRICS_DIR_NAME}/${METRICS_FILE_NAME}`

function apiFor (platform) {
  return platform === 'win32' ? path.win32 : path.posix
}

/**
 * Is measurement recording switched on? Only the literal '1' (surrounding whitespace ignored)
 * counts — 'true', 'yes' and '0' all mean off, so a typo cannot silently enable a write.
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function isMeasureEnabled (env = process.env) {
  const raw = env?.[MEASURE_ENV]
  return typeof raw === 'string' && raw.trim() === '1'
}

/**
 * Directory the metrics file is rooted at: PORTABLE_EXECUTABLE_DIR when the portable launcher set
 * it (electron-builder `portable` target), otherwise the directory holding the running exe.
 * @param {Record<string, string|undefined>} [env]
 * @param {string} [execPath]  process.execPath by default
 * @param {NodeJS.Platform|string} [platform]
 * @returns {string} absolute directory
 */
export function metricsBaseDir (env = process.env, execPath = process.execPath, platform = process.platform) {
  const api = apiFor(platform)
  const portable = normalizePortableDir(env?.PORTABLE_EXECUTABLE_DIR, platform)
  if (portable) return portable

  const exe = typeof execPath === 'string' ? execPath.trim() : ''
  if (!exe) throw new TypeError('metricsBaseDir: execPath is required when PORTABLE_EXECUTABLE_DIR is absent')

  // process.execPath is absolute in both plain node and the Electron main/renderer process. A
  // relative execPath can only be made absolute against cwd, and that is the caller's bad input,
  // not a silent default: keep it absolute so the returned path is never cwd-relative.
  const dir = api.dirname(exe)
  return api.isAbsolute(dir) ? api.normalize(dir) : api.resolve(dir)
}

/**
 * The metrics file path.
 *   1. `SMARTSSH_MEASURE_PATH` set  -> that path (relative values rooted at {@link metricsBaseDir})
 *   2. otherwise                    -> `<base>/data/metrics.json`
 * Never consults cwd for the default branch.
 * @param {Record<string, string|undefined>} [env]
 * @param {string} [execPath]
 * @param {NodeJS.Platform|string} [platform]
 * @returns {string} absolute path
 */
export function resolveMetricsPath (env = process.env, execPath = process.execPath, platform = process.platform) {
  const api = apiFor(platform)
  const base = metricsBaseDir(env, execPath, platform)

  const rawOverride = env?.[MEASURE_PATH_ENV]
  const override = typeof rawOverride === 'string' ? rawOverride.trim() : ''
  if (override) {
    return api.isAbsolute(override) ? api.normalize(override) : api.join(base, override)
  }
  return api.join(base, METRICS_DIR_NAME, METRICS_FILE_NAME)
}
