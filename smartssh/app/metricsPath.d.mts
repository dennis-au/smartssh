// Types for metricsPath.mjs, consumed by the renderer (TS) at build time.
export declare const MEASURE_ENV: 'SMARTSSH_MEASURE'
export declare const MEASURE_PATH_ENV: 'SMARTSSH_MEASURE_PATH'
export declare const METRICS_DIR_NAME: 'data'
export declare const METRICS_FILE_NAME: 'metrics.json'
export declare const METRICS_RELATIVE_PATH: 'data/metrics.json'

export type MeasureEnv = Record<string, string|undefined>

export declare function isMeasureEnabled (env?: MeasureEnv): boolean
export declare function metricsBaseDir (env?: MeasureEnv, execPath?: string, platform?: string): string
export declare function resolveMetricsPath (env?: MeasureEnv, execPath?: string, platform?: string): string
