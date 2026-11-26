// Portable userData redirect. Imported by index.ts *before* anything reads
// app.getPath('userData') (config, logging, single-instance lock) and long before app.whenReady().
//
// electron-builder's `portable` target sets PORTABLE_EXECUTABLE_DIR to the folder holding the .exe.
// The path maths lives in smartssh/app/portablePath.mjs so it can be unit-tested off-Windows; this
// file only does the two things a unit test cannot: probe writability and call app.setPath().
//
// Behaviour kept from upstream Tabby: if there is no PORTABLE_EXECUTABLE_DIR but <exe dir>/data
// exists, that folder is still used. Plain dev/installed runs (no portable dir) are untouched —
// app.getPath('userData') is returned unchanged.

import * as path from 'path'
import * as fs from 'fs'
import * as electron from 'electron'
import {
    resolveUserDataPath,
    normalizePortableDir,
    probeWritableDir,
    type UserDataResolution,
} from '../../smartssh/app/portablePath.mjs'

const platform = process.platform
const fallbackUserData = electron.app.getPath('userData')
const portableEnv = process.env.PORTABLE_EXECUTABLE_DIR
const hasPortableEnv = normalizePortableDir(portableEnv, platform) !== null

// Upstream Tabby convention, only consulted when the portable wrapper did not set the env var.
const exeDir = path.dirname(electron.app.getPath('exe'))
const legacyRoot = fs.existsSync(path.join(exeDir, 'data')) ? exeDir : null

const portableRoot: string | null = normalizePortableDir(hasPortableEnv ? portableEnv : legacyRoot, platform)

const resolution: UserDataResolution = resolveUserDataPath({
    portableDir: portableRoot,
    // Probe the portable root, never <root>/data: on a Windows folder with a CreateFiles Deny ACE
    // (windows-checklist.ps1 item 2) mkdir would still succeed and leave a `data` folder behind.
    isWritable: portableRoot ? probeWritableDir(portableRoot) : undefined,
    platform,
    fallbackUserData,
})

if (resolution.portable) {
    // The only directory ever created is the one the resolver picked: <portable>/data when the
    // probe said writable, otherwise the scratch dir. Nothing is created under a read-only root.
    try {
        fs.mkdirSync(resolution.path, { recursive: true })
    } catch { }
    if (resolution.readOnlyMode) {
        // Read-only medium: run on scratch space instead of silently writing to %LOCALAPPDATA%.
        console.warn(`[smartssh] portable root is read-only, using ${resolution.path}`)
    } else {
        console.log(`[smartssh] portable userData -> ${resolution.path}`)
    }
    electron.app.setPath('userData', resolution.path)
}

// Exposed for the UI/diagnostics: the renderer cannot see the main process's resolution otherwise.
process.env.SMARTSSH_USERDATA_PATH = resolution.path
process.env.SMARTSSH_PORTABLE_READONLY = resolution.readOnlyMode ? '1' : '0'

export const portableState: UserDataResolution = resolution
