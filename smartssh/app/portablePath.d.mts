// Types for portablePath.mjs, consumed by the Electron main process (TS) at build time.
export interface UserDataResolution {
    path: string
    portable: boolean
    writable: boolean
    readOnlyMode: boolean
    reason: 'no-portable-dir' | 'portable-writable' | 'portable-read-only'
}

export interface ResolveUserDataPathInput {
    portableDir?: string | null
    isWritable?: boolean
    platform?: string
    fallbackUserData?: string
    tmpDir?: string
}

export declare const READ_ONLY_DIR_NAME: 'smartssh-ro'
export declare const DATA_DIR_NAME: 'data'
export declare const PORTABLE_REASON: {
    readonly NO_PORTABLE_DIR: 'no-portable-dir'
    readonly PORTABLE_WRITABLE: 'portable-writable'
    readonly PORTABLE_READ_ONLY: 'portable-read-only'
}

export declare function normalizePortableDir (portableDir: string | null | undefined, platform?: string): string | null
export declare function portableDataDir (portableDir: string | null | undefined, platform?: string): string | null
export declare function probeWritableDir (dir: string): boolean
export declare function resolveUserDataPath (input?: ResolveUserDataPathInput): UserDataResolution
