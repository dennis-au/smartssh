// contract: v53
const INVISIBLES = /[\u00AD\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu
const BIDI = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/u

function codePointLabel (character) {
  return 'U+' + character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
}

export function previewText (payload) {
  const text = payload?.text
  if (typeof text !== 'string') throw new Error('preview payload has no text')
  return text
}

export function scanInvisibles (text) {
  // Raw, context-free code-point counts for diagnostics only, not warnings.
  let zeroWidth = 0
  let bidi = 0
  let deception = 0
  let suspicious = 0
  let legitimate = 0
  const codePoints = new Set()
  for (const { 0: character, index } of text.matchAll(INVISIBLES)) {
    const isBidi = BIDI.test(character)
    if (isBidi) bidi++
    else zeroWidth++

    const isJoiner = character === '\u200C' || character === '\u200D'
    const asciiFlanked = isJoiner && text.charCodeAt(index - 1) <= 0x7F && text.charCodeAt(index + 1) <= 0x7F
    if (isBidi || asciiFlanked) {
      deception++
    } else if (isJoiner || (character === '\uFEFF' && index === 0)) {
      legitimate++
      continue
    } else {
      suspicious++
    }
    codePoints.add(codePointLabel(character))
  }
  return {
    deception,
    suspicious,
    legitimate,
    total: deception + suspicious, // User-facing count; excludes legitimate characters.
    rawTotal: deception + suspicious + legitimate, // Diagnostics only.
    zeroWidth,
    bidi,
    codePoints: [...codePoints].sort(),
  }
}

export function payloadSeverity (payload) {
  if (payload?.masks?.some(mask => mask.invisibleInside > 0)) return 'deception'
  return scanInvisibles(previewText(payload)).suspicious > 0 ? 'suspicious' : 'none'
}

// display is for rendering only. The clipboard source is always previewText(payload),
// never display. In the DOM, render placeholders as CSS ::before content, not text
// nodes, so selection does not copy them. Apply mask offsets to the raw text.
export function previewDisplay (payload, { showInvisibles = false } = {}) {
  const text = previewText(payload)
  const { deception, suspicious, codePoints } = scanInvisibles(text)
  const warnings = []
  if (deception) {
    const hasDeceptiveJoiner = codePoints.includes('U+200C') || codePoints.includes('U+200D')
    const message = hasDeceptiveJoiner
      ? `含有 ${deception} 個可能隱藏內容或影響顯示次序的字元`
      : `含有 ${deception} 個可能影響顯示次序的雙向控制字元`
    warnings.push({ kind: 'banner', text: message })
  }
  if (suspicious) warnings.push({ kind: 'detail', text: `含有 ${suspicious} 個可疑的零寬字元` })
  const display = showInvisibles
    ? text.replace(INVISIBLES, character => `⟦${codePointLabel(character)}⟧`)
    : text
  return { display, warnings }
}
