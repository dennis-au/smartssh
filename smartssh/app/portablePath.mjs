// smartssh/app/portablePath.mjs — where SmartSSH keeps its userData in portable builds.
//
// Pure: no Electron import, no filesystem writes, no global state. The main process probes
// writability and passes the answer in, so every branch here is unit-testable off-Windows.
//
// Contract (electron-builder `portable` target sets PORTABLE_EXECUTABLE_DIR to the folder that
// holds the .exe):
//   portable dir + writable      -> <portable dir>/data
//   portable dir + NOT writable  -> <tmp dir>/smartssh-ro   (read-only mode, NEVER %LOCALAPPDATA%)
//   no portable dir              -> the caller's normal Electron userData path (dev/installed)
//
// The read-only branch must never fall back to the Electron userData path: on Windows that is
// %APPDATA%/%LOCALAPPDATA%, and windows-checklist.ps1 item 2 fails the build if a read-only
// portable launch silently writes there.
//
// Return shape: one flat record for every branch —
//   { path, portable, writable, readOnlyMode, reason }
// `path` is the only thing callers hand to app.setPath('userData', ...); the flags exist so the UI
// and diagnostics can show "read-only portable" instead of failing mysteriously later.

import * as path from 'path'
import * as os from 'node:os'
import * as fs from 'node:fs'

export const READ_ONLY_DIR_NAME = 'smartssh-ro'
export const DATA_DIR_NAME = 'data'

const REASON = Object.freeze({
    NO_PORTABLE_DIR: 'no-portable-dir',
    PORTABLE_WRITABLE: 'portable-writable',
    PORTABLE_READ_ONLY: 'portable-read-only',
})

function apiFor (platform) {
    return platform === 'win32' ? path.win32 : path.posix
}

function freeze (record) {
    return Object.freeze(record)
}

/**
 * Normalise a PORTABLE_EXECUTABLE_DIR value: trim, drop trailing separators, keep roots intact.
 * Returns null for "no portable dir" (undefined, null, '', whitespace, non-string).
 * UNC paths (`\\server\share\app`) survive untouched apart from separator trimming.
 * @returns {string|null}
 */
export function normalizePortableDir (portableDir, platform = process.platform) {
    if (typeof portableDir !== 'string') return null
    let dir = portableDir.trim()
    if (!dir) return null

    // 'C:\' and '/' are roots: trimming their separator would change their meaning.
    const isDriveRoot = /^[a-zA-Z]:[\\/]$/.test(dir)
    if (!isDriveRoot) {
        while (dir.length > 1 && /[\\/]$/.test(dir)) {
            dir = dir.slice(0, -1)
        }
    }
    if (!dir || dir === '') return null
    return dir
}

/**
 * The folder that holds the portable data. The main process writes its write-probe here, so it
 * must be derived by the same code the resolver uses — no second implementation to drift.
 * @returns {string|null}
 */
export function portableDataDir (portableDir, platform = process.platform) {
    const dir = normalizePortableDir(portableDir, platform)
    if (!dir) return null
    return apiFor(platform).join(dir, DATA_DIR_NAME)
}

/**
 * Is `dir` writable? Probed by creating and removing a probe *file in that directory*.
 *
 * Deliberately NOT `mkdir(dir/'data')`: on Windows a Deny ACE of `CreateFiles,WriteData`
 * (exactly what windows-checklist.ps1 applies) still allows FILE_ADD_SUBDIRECTORY, so a mkdir
 * probe would create `data` on a read-only medium — and checklist item 2 then fails on
 * "<portable>\data exists" even though the app behaved correctly. A file probe is denied by the
 * same ACE, leaves nothing behind either way, and needs no cleanup on failure.
 * @returns {boolean}
 */
export function probeWritableDir (dir) {
    if (typeof dir !== 'string' || !dir.trim()) return false
    const probe = path.join(dir.trim(), `.smartssh-write-probe-${process.pid}`)
    try {
        fs.writeFileSync(probe, '')
        fs.unlinkSync(probe)
        return true
    } catch {
        return false
    }
}

/**
 * @param {object} input
 * @param {string|null|undefined} input.portableDir   value of PORTABLE_EXECUTABLE_DIR
 * @param {boolean|undefined}      input.isWritable   result of probeWritableDir(portable dir);
 *                                                    only `false` means read-only
 * @param {string}                [input.platform]    process.platform by default
 * @param {string}                [input.fallbackUserData] app.getPath('userData')
 * @param {string}                [input.tmpDir]      os.tmpdir() by default; injectable for tests
 * @returns {{path: string, portable: boolean, writable: boolean, readOnlyMode: boolean, reason: string}}
 */
export function resolveUserDataPath ({ portableDir, isWritable, platform = process.platform, fallbackUserData, tmpDir } = {}) {
    const api = apiFor(platform)
    const dir = normalizePortableDir(portableDir, platform)

    if (!dir) {
        if (typeof fallbackUserData !== 'string' || !fallbackUserData.trim()) {
            throw new TypeError('resolveUserDataPath: fallbackUserData is required when portableDir is absent')
        }
        return freeze({
            path: fallbackUserData,
            portable: false,
            writable: true,
            readOnlyMode: false,
            reason: REASON.NO_PORTABLE_DIR,
        })
    }

    if (isWritable !== false) {
        return freeze({
            path: api.join(dir, DATA_DIR_NAME),
            portable: true,
            writable: true,
            readOnlyMode: false,
            reason: REASON.PORTABLE_WRITABLE,
        })
    }

    // Read-only medium (CD, signed/ACL-locked USB stick, Windows folder with a Deny ACE).
    // Deliberately not the fallback path: no silent %LOCALAPPDATA% writes.
    const tmpRoot = (typeof tmpDir === 'string' && tmpDir.trim()) ? tmpDir.trim() : os.tmpdir()
    return freeze({
        path: api.join(tmpRoot, READ_ONLY_DIR_NAME),
        portable: true,
        writable: false,
        readOnlyMode: true,
        reason: REASON.PORTABLE_READ_ONLY,
    })
}

export { REASON as PORTABLE_REASON }
