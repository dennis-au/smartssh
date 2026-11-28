// Types for vcredist.mjs, consumed by the Electron main process (TS) at build time.
export declare const RUNTIME_DLLS: readonly string[]
export declare const EXIT_CODE_MISSING_RUNTIME: 3
export declare const REDIST_INSTALLER_NAME: 'vc_redist.x64.exe'
export declare const REDIST_URL: string
export declare const REDIST_DOCS_URL: string
export declare const RUNTIME_TITLE_ZH: string
export declare const RUNTIME_TITLE_EN: string

export interface RuntimeDllHit {
    dll: string
    dir: string
}

export interface RuntimeDllMiss {
    dll: string
    searched: string[]
}

export interface RuntimeProbe {
    ok: boolean
    dirs: string[]
    found: RuntimeDllHit[]
    missing: RuntimeDllMiss[]
}

export interface RuntimeCheck extends RuntimeProbe {
    applicable: boolean
    platform: string
    message: string
}

export interface RuntimeDirsInput {
    platform?: string
    systemRoot?: string
    exeDir?: string
    portableDir?: string
}

export interface RuntimeCheckInput extends RuntimeDirsInput {
    exists?: (path: string) => boolean
}

export declare function isWindowsPlatform (platform?: string): boolean
export declare function runtimeDirs (input?: RuntimeDirsInput): string[]
export declare function findRuntimeDlls (input: {
    dirs: string[]
    exists: (path: string) => boolean
    dlls?: readonly string[]
}): RuntimeProbe
export declare function checkRuntime (input?: RuntimeCheckInput): RuntimeCheck
export declare function runtimeMessage (result: RuntimeProbe): string
export declare function findRedistInstaller (input: {
    dirs: string[]
    exists: (path: string) => boolean
    name?: string
}): { path: string, dir: string } | null
