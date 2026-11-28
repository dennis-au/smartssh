import { CASE_SPEC } from './proposalService.mjs'
import { isMeasureEnabled } from './metricsPath.mjs'

export const DEFAULT_MEASURE_CASE = '683x512'

/**
 * In measurement mode the window has to BE the case geometry. Otherwise the renderer can only
 * declare the numbers and the judge -- correctly -- refuses a file with no live measurement.
 * @param {Record<string, string|undefined>} [env]
 * @returns {null|{caseId: string, width: number|null, height: number|null, note: string}}
 */
export function measurementWindow (env = {}) {
  // One switch, one meaning: isMeasureEnabled() is the same predicate the recorder uses.
  if (!isMeasureEnabled(env)) return null
  const raw = env.SMARTSSH_MEASURE_CASE
  const caseId = (typeof raw === 'string' && raw.trim()) || DEFAULT_MEASURE_CASE
  if (!Object.prototype.hasOwnProperty.call(CASE_SPEC, caseId)) {
    return { caseId, width: null, height: null, note: `SMARTSSH_MEASURE_CASE must be one of ${Object.keys(CASE_SPEC).join(', ')}; got ${caseId}` }
  }
  const { wCss, hCss } = CASE_SPEC[caseId].window
  return { caseId, width: wCss, height: hCss, note: '' }
}
