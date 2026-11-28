// smartssh/app/vcredist.mjs — "is the Visual C++ 2015-2022 x64 runtime here?" as a pure decision.
//
// Why this module exists: on a clean Windows image (OEM/minimal image, Server Core, a fresh
// Enterprise Eval install) `vcruntime140.dll` / `msvcp140.dll` may be absent. SmartSSH then starts,
// puts the splash on screen and never draws a window, because the SSH engine is a native addon
// (`russh.win32-x64-msvc.node`) whose dlopen fails with Windows error 126 and the renderer never
// boots (NullInjectorError: No provider for HostAppService). Nothing in that path said why.
//
// The decision and its wording live here, without an `electron` import, so it can be unit-tested on
// any host: the Electron main process (app/lib/vcredistPreflight.ts) and the acceptance checklist
// (smartssh/verify/windows-checklist.ps1) both have to agree, and vcredist-preflight.test.mjs pins
// that the PowerShell side still carries these exact constants.
//
// Three-state, like the rest of this repo: the caller probes, this module decides. `exists` is
// injected so no test has to install a runtime (or delete one) to prove the logic.

/** Files the SSH native addon needs at load time. Both halves are required, so both are listed. */
export const RUNTIME_DLLS = Object.freeze(['vcruntime140.dll', 'msvcp140.dll'])

/** Exit code shared by every entry point that refuses to measure without the runtime. */
export const EXIT_CODE_MISSING_RUNTIME = 3

/** Offline drop-in: if this file sits next to the exe, the dialog can offer to run it. */
export const REDIST_INSTALLER_NAME = 'vc_redist.x64.exe'

/** Microsoft's stable "latest x64 redistributable" redirect (a real, downloadable .exe). */
export const REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'

/** Human-readable "which runtime" page; the dialog and the README both cite it. */
export const REDIST_DOCS_URL = 'https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist'

/**
 * The one sentence a user must be able to read and act on. Kept as a constant because the
 * acceptance checklist asserts it verbatim (and so does the PowerShell drift test).
 */
export const RUNTIME_TITLE_ZH = '需要 Microsoft Visual C++ 2015–2022 x64 Redistributable'
export const RUNTIME_TITLE_EN = 'Microsoft Visual C++ 2015–2022 x64 Redistributable is required'

export function isWindowsPlatform (platform = process.platform) {
    return platform === 'win32'
}

/**
 * Directories to search for the runtime DLLs, most specific first.
 *
 * Order matters: a DLL dropped next to the exe (app-local deployment) is what the process actually
 * loads, so it is reported first. `portableDir` is the folder the user sees (electron-builder's
 * PORTABLE_EXECUTABLE_DIR), `exeDir` the folder the running image was extracted to — on the
 * portable target those are two different places, and a user may legitimately drop the DLLs in
 * either one. System32 (a machine-wide runtime install) is last.
 *
 * @param {{platform?: string, systemRoot?: string, exeDir?: string, portableDir?: string}} [input]
 * @returns {string[]} unique, non-empty, platform-correct paths
 */
export function runtimeDirs (input = {}) {
    const platform = input.platform ?? process.platform
    const join = platform === 'win32'
        ? (...parts) => joinWin32(parts)
        : (...parts) => joinPosix(parts)

    const candidates = [input.portableDir, input.exeDir]
    if (input.systemRoot) candidates.push(join(input.systemRoot, 'System32'))

    const out = []
    const seen = new Set()
    for (const candidate of candidates) {
        if (typeof candidate !== 'string' || candidate.length === 0) continue
        const normalised = platform === 'win32' ? candidate.replace(/\//g, '\\').replace(/\\+$/, '') : candidate.replace(/\/+$/, '')
        if (normalised.length === 0) continue
        const key = platform === 'win32' ? normalised.toLowerCase() : normalised
        if (seen.has(key)) continue
        seen.add(key)
        out.push(normalised)
    }
    return out
}

function joinWin32 (parts) {
    const clean = parts.filter((p) => typeof p === 'string' && p.length > 0)
    const first = clean.shift().replace(/\//g, '\\')
    const rest = clean.map((p) => p.replace(/^[\\/]+|[\\/]+$/g, '').replace(/\//g, '\\'))
    return [first.replace(/\\+$/, ''), ...rest].join('\\')
}

function joinPosix (parts) {
    const clean = parts.filter((p) => typeof p === 'string' && p.length > 0)
    const first = clean.shift().replace(/\/+$/, '')
    const rest = clean.map((p) => p.replace(/^\/+|\/+$/g, ''))
    return [first, ...rest].join('/')
}

/**
 * Which of RUNTIME_DLLS are reachable, and from where.
 *
 * @param {{dirs: string[], exists: (path: string) => boolean, dlls?: readonly string[]}} input
 * @returns {{ok: boolean, dirs: string[], found: {dll: string, dir: string}[], missing: {dll: string, searched: string[]}[]}}
 */
export function findRuntimeDlls (input) {
    const dirs = Array.isArray(input?.dirs) ? input.dirs : []
    const exists = input?.exists
    if (typeof exists !== 'function') throw new TypeError('findRuntimeDlls: exists(path) is required')
    const dlls = input?.dlls ?? RUNTIME_DLLS

    const found = []
    const missing = []
    for (const dll of dlls) {
        let hit = null
        for (const dir of dirs) {
            const candidate = isWinPath(dir) ? joinWin32([dir, dll]) : joinPosix([dir, dll])
            let present = false
            try {
                present = exists(candidate) === true
            } catch {
                // An unreadable directory is "not found", never "assume fine".
                present = false
            }
            if (present) { hit = { dll, dir }
                break }
        }
        if (hit) found.push(hit)
        else missing.push({ dll, searched: [...dirs] })
    }
    return { ok: missing.length === 0, dirs: [...dirs], found, missing }
}

function isWinPath (p) {
    return /^[A-Za-z]:/.test(p) || p.includes('\\')
}

/**
 * Full preflight: applicability, probe, and the message a human ends up reading.
 *
 * @param {{platform?: string, systemRoot?: string, exeDir?: string, portableDir?: string,
 *          exists?: (path: string) => boolean}} [input]
 */
export function checkRuntime (input = {}) {
    const platform = input.platform ?? process.platform
    if (!isWindowsPlatform(platform)) {
        return { applicable: false, ok: true, platform, dirs: [], found: [], missing: [], message: '' }
    }
    const dirs = runtimeDirs({ platform, systemRoot: input.systemRoot, exeDir: input.exeDir, portableDir: input.portableDir })
    const exists = typeof input.exists === 'function' ? input.exists : null
    if (!exists) throw new TypeError('checkRuntime: exists(path) is required on win32')

    const result = findRuntimeDlls({ dirs, exists })
    return {
        applicable: true,
        ok: result.ok,
        platform,
        dirs: result.dirs,
        found: result.found,
        missing: result.missing,
        message: result.ok ? '' : runtimeMessage(result),
    }
}

/**
 * The user-facing text. Bilingual on purpose: the failing machine may be either locale, and a
 * support engineer needs the technical line (error 126 / which DLL) without a debugger.
 *
 * Contains, and must keep containing, RUNTIME_TITLE_ZH and REDIST_URL — the contract the checklist
 * and the tests assert.
 */
export function runtimeMessage (result) {
    const missing = (result?.missing ?? []).map((m) => m.dll)
    const dirs = result?.dirs ?? []
    const missingLine = missing.length > 0 ? missing.join(', ') : RUNTIME_DLLS.join(', ')
    const searchedLine = dirs.length > 0 ? dirs.join('; ') : '(no directory had to be searched / 無)'

    return [
        `${RUNTIME_TITLE_ZH}`,
        `${RUNTIME_TITLE_EN}`,
        '',
        `缺少 / missing: ${missingLine}`,
        `已搜尋 / searched: ${searchedLine}`,
        '',
        '原因 / why: SmartSSH 的 SSH 引擎是原生模組（russh.win32-x64-msvc.node），缺 runtime 時 Windows 回報',
        'error 126（找不到相依 DLL），主視窗因此永遠停在 splash。裝好 runtime 即正常。',
        'The SSH engine is a native module; Windows fails to load it (error 126), so the main window never opens.',
        '',
        '處理 / fix:',
        `  1. 下載並安裝 x64 版（唔係 x86）/ download and install the x64 build: ${REDIST_URL}`,
        '  2. 裝完按「已安裝，重試」/ then choose "Retry".',
        `  說明 / docs: ${REDIST_DOCS_URL}`,
    ].join('\n')
}

/**
 * A redistributable installer the user dropped next to the exe (offline install path), or null.
 * Never downloads anything: an unsigned helper must not fetch and execute a binary on its own.
 *
 * @param {{dirs: string[], exists: (path: string) => boolean, name?: string}} input
 * @returns {{path: string, dir: string} | null}
 */
export function findRedistInstaller (input) {
    const dirs = Array.isArray(input?.dirs) ? input.dirs : []
    const exists = input?.exists
    if (typeof exists !== 'function') throw new TypeError('findRedistInstaller: exists(path) is required')
    const name = input?.name ?? REDIST_INSTALLER_NAME
    for (const dir of dirs) {
        const candidate = isWinPath(dir) ? joinWin32([dir, name]) : joinPosix([dir, name])
        try {
            if (exists(candidate) === true) return { path: candidate, dir }
        } catch {
            // ignore unreadable dirs
        }
    }
    return null
}
