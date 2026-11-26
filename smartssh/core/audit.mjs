// contract: v53
import { ASSIGNMENT_PATTERN, stripInvisible } from './redact.mjs'

// For labeled credentials, the span starts at the value, not the label.
const PATTERNS = [
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/dgi],
  ['sk', /\bsk-[A-Za-z0-9_-]{8,}/dgi],
  ['ghp', /\bghp_[A-Za-z0-9_-]{8,}/dgi],
  ['akia', /\bAKIA[A-Za-z0-9_-]{8,}/dgi],
  ['xoxb', /\bxoxb-[A-Za-z0-9_-]{8,}/dgi],
  ['bearer', /\bBearer\s+(\S{8,})/dgi],
  ['password_prompt', /(?:^|\n)[ \t]*[^\n:]*password[^:\n]*:[ \t]*(\S+)/dgi],
  ['env_key', ASSIGNMENT_PATTERN],
]

const ENTROPY_PATTERNS = [
  ['high_entropy', /(?<![\w+/-])(?:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}|[\da-f]{32,}|[a-z\d+/]{40,}={0,2})(?![\w+/-])/dgi],
]

// Look up the first surviving unit at or after a raw offset in stripInvisible's map.
function lowerBound (map, index) {
  let lo = 0
  let hi = map.length
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (map[mid] < index) lo = mid + 1
    else hi = mid
  }
  return lo
}

function scanSpans (text, { stripped, map }, masks, patterns) {
  const findings = new Map()
  for (const [kind, pattern] of patterns) {
    for (const [subject, toSource] of [[text, null], [stripped, map]]) {
      for (const match of subject.matchAll(pattern)) {
        const [start, stop] = match.indices[1] ?? match.indices[0]
        if (kind === 'env_key' && stop - start < 8) continue
        const index = toSource ? toSource[start] : start
        const end = toSource ? toSource[stop - 1] + 1 : stop
        const visibleStart = toSource ? index : map[lowerBound(map, index)]
        const normalisedSource = visibleStart < end ? visibleStart : null
        // Raw and stripped matches can differ only by leading invisibles at
        // their start. Pair those matches, retaining the earliest source start.
        const key = normalisedSource === null ? `${kind}:raw:${index}` : `${kind}:${normalisedSource}`
        const previous = findings.get(key)
        if (previous) {
          previous.index = Math.min(previous.index, index)
          previous.end = Math.max(previous.end, end)
        } else {
          findings.set(key, { kind, index, end, normalisedSource })
        }
      }
    }
  }
  const covers = index => masks.some(({ srcStart, srcEnd }) => srcStart <= index && index < srcEnd)
  return [...findings.values()].sort((a, b) => a.index - b.index).map(({ kind, index, end, normalisedSource }) => ({
    span: { kind, index, end, covered: covers(index) },
    // A projected mask contains the normalised start iff the original mask
    // contains the source unit mapped from that start.
    normalisedCovered: normalisedSource !== null && covers(normalisedSource),
  }))
}

const unmasked = ({ span, normalisedCovered }) => !span.covered && !normalisedCovered
const inconsistent = ({ span, normalisedCovered }) => span.covered !== normalisedCovered
const spanOf = ({ span }) => span
const credentials = (text, masks) => scanSpans(text, stripInvisible(text), masks, PATTERNS)

export function auditSpans (text, masks) {
  return credentials(text, masks).map(spanOf)
}

export function auditUnmasked (text, masks) {
  return credentials(text, masks).filter(unmasked).map(spanOf)
}

export function auditInconsistent (text, masks) {
  return credentials(text, masks).filter(inconsistent).map(spanOf)
}

// Payload consumers need all tiers; reuse the same scans and normalisation.
export function auditCoverage (text, masks) {
  const domain = stripInvisible(text)
  const findings = scanSpans(text, domain, masks, PATTERNS)
  const highEntropyCount = scanSpans(text, domain, masks, ENTROPY_PATTERNS).filter(finding => {
    if (!unmasked(finding)) return false
    const { index, end } = finding.span
    return !findings.some(({ span }) => index < span.end && span.index < end)
  }).length
  return {
    inconsistent: findings.filter(inconsistent).map(spanOf),
    uncovered: findings.filter(unmasked).map(spanOf),
    highEntropyCount,
  }
}
