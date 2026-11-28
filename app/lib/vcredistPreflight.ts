// VC++ 2015-2022 x64 runtime preflight for the Electron main process.
//
// The failing path this replaces, measured on a clean Windows 11 24H2 image:
//   smartssh-1.0.242-portable-x64.exe  ->  splash drawn  ->  russh.win32-x64-msvc.node dlopen fails
//   (Windows error 126)  ->  renderer throws NullInjectorError: No provider for HostAppService
//   ->  no main window, ever, and nothing on screen said why.
//
// The decision itself lives in smartssh/app/vcredist.mjs (unit-tested off-Windows); this file only
// does what a unit test cannot: probe the real filesystem, show a real dialog, and (optionally) run
// an installer the user put next to the exe. It runs before any window exists, so a missing runtime
// can never present as a splash that never advances again.

import { app, dialog, shell } from 'electron'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import {
    checkRuntime,
    findRedistInstaller,
    isWindowsPlatform,
    RUNTIME_TITLE_EN,
    RUNTIME_TITLE_ZH,
    REDIST_URL,
    type RuntimeCheck,
} from '../../smartssh/app/vcredist.mjs'

const PRODUCT = 'Smart SSH'

/**
 * Acceptance-only seam: force the "runtime missing" verdict so the dialog path can be proven on a
 * machine that *has* the runtime, without renaming anything in System32. It can only make the app
 * refuse to start, never let it through, so it cannot be used to fake a pass.
 */
const SIMULATE_ENV = 'SMARTSSH_SIMULATE_MISSING_VCRUNTIME'

export interface RuntimePreflight extends RuntimeCheck {
    installerPath: string | null
}

function probe (): RuntimeCheck {
    const target = {
        platform: process.platform,
        systemRoot: process.env.SystemRoot ?? process.env.windir ?? undefined,
        // The folder the running image was extracted to (portable target: a temp dir).
        exeDir: path.dirname(app.getPath('exe')),
        // The folder the user actually sees and can drop a DLL / installer into.
        portableDir: process.env.PORTABLE_EXECUTABLE_DIR ?? undefined,
    }

    if (process.env[SIMULATE_ENV] === '1') {
        const forced = checkRuntime({ ...target, platform: 'win32', exists: () => false })
        return {
            ...forced,
            message: `(simulated / 模擬: ${SIMULATE_ENV}=1 — no DLL was actually removed)\n${forced.message}`,
        }
    }

    return checkRuntime({ ...target, exists: (p: string) => fs.existsSync(p) })
}

/**
 * Probe once, at main-process start-up (see app/lib/index.ts). Non-Windows runs are a no-op.
 * Never throws: a preflight that itself crashes the app would be the same bug with a new stack.
 */
export function runRuntimePreflight (): RuntimePreflight {
    try {
        const result = probe()
        const installer = result.applicable && !result.ok
            ? findRedistInstaller({ dirs: result.dirs, exists: (p: string) => fs.existsSync(p) })
            : null
        return { ...result, installerPath: installer?.path ?? null }
    } catch (err) {
        // Unknown state: let the app try (the old behaviour) rather than block a working machine.
        console.error('[smartssh] runtime preflight failed to run:', err)
        return {
            applicable: false,
            ok: true,
            platform: process.platform,
            dirs: [],
            found: [],
            missing: [],
            message: '',
            installerPath: null,
        }
    }
}

/** Run the user-supplied installer and resolve when it exits. Elevation is the installer's job (UAC). */
function runInstaller (installerPath: string): Promise<number | null> {
    return new Promise((resolvePromise) => {
        try {
            const child = spawn(installerPath, ['/install', '/passive', '/norestart'], {
                detached: false,
                stdio: 'ignore',
                windowsHide: false,
            })
            child.on('close', (code) => resolvePromise(code))
            child.on('error', (err) => {
                console.error('[smartssh] redist installer failed to start:', err)
                resolvePromise(null)
            })
        } catch (err) {
            console.error('[smartssh] redist installer threw:', err)
            resolvePromise(null)
        }
    })
}

/**
 * Show the readable error and let the user fix it without leaving the app.
 *
 * Returns 'continue' only when a re-probe found the runtime (the caller then starts normally);
 * otherwise the process exits with EXIT_CODE_MISSING_RUNTIME, because starting would reproduce
 * exactly the silent splash this dialog replaces.
 */
export async function presentMissingRuntime (first: RuntimePreflight): Promise<'continue' | 'exit'> {
    let current = first

    for (;;) {
        const withInstaller = current.installerPath !== null
        const buttons: string[] = []
        if (withInstaller) buttons.push('安裝本機的 vc_redist.x64.exe（Install）')
        buttons.push('開啟下載頁面（Open download page）')
        buttons.push('已安裝，重試（Retry）')
        buttons.push('結束（Quit）')

        const installId = withInstaller ? 0 : -1
        const downloadId = withInstaller ? 1 : 0
        const retryId = withInstaller ? 2 : 1
        const quitId = buttons.length - 1

        let choice: number
        try {
            choice = dialog.showMessageBoxSync({
                type: 'error',
                title: `${PRODUCT} · ${RUNTIME_TITLE_ZH}`,
                message: `${PRODUCT} 無法啟動：${RUNTIME_TITLE_ZH}\n${PRODUCT} cannot start: ${RUNTIME_TITLE_EN}`,
                detail: current.message,
                buttons,
                defaultId: withInstaller ? installId : downloadId,
                cancelId: quitId,
                noLink: true,
            })
        } catch (err) {
            // No display / dialog unavailable: at least leave the reason in the log and the exit code.
            console.error('[smartssh] could not show the runtime dialog:', err)
            console.error(current.message)
            return 'exit'
        }

        if (choice === quitId) return 'exit'

        if (choice === installId) {
            const code = await runInstaller(current.installerPath as string)
            console.log('[smartssh] vc_redist installer exit code:', code)
        } else if (choice === downloadId) {
            try {
                await shell.openExternal(REDIST_URL)
            } catch (err) {
                console.error('[smartssh] could not open the download page:', err)
            }
            // Fall through to the retry prompt below instead of silently returning to a dead splash.
            current = { ...probe(), installerPath: current.installerPath }
            if (current.ok) return 'continue'
            continue
        } else if (choice === retryId) {
            current = { ...probe(), installerPath: current.installerPath }
            if (current.ok) return 'continue'
        } else {
            // Window closed by the user.
            return 'exit'
        }
    }
}

export function isApplicable (result: RuntimePreflight): boolean {
    return result.applicable && isWindowsPlatform(result.platform)
}
