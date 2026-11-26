// contract: v47
const INVISIBLES = /[\u00AD\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu

function codePointLabel (character) {
  return 'U+' + character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
}

export function previewText (payload) {
  const text = payload?.text
  if (typeof text !== 'string') throw new Error('preview payload has no text')
  return text
}

export function scanInvisibles (text) {
  let zeroWidth = 0
  let bidi = 0
  const codePoints = new Set()
  for (const [character] of text.matchAll(INVISIBLES)) {
    if (character >= '\u202A' && character <= '\u2069') bidi++
    else zeroWidth++
    codePoints.add(codePointLabel(character))
  }
  return { zeroWidth, bidi, total: zeroWidth + bidi, codePoints: [...codePoints].sort() }
}

// display is for rendering only. The clipboard source is always previewText(payload),
// never display. In the DOM, render placeholders as CSS ::before content, not text
// nodes, so selection does not copy them. Apply mask offsets to the raw text.
export function previewDisplay (payload, { showInvisibles = false } = {}) {
  const text = previewText(payload)
  const { zeroWidth, bidi, total } = scanInvisibles(text)
  const warnings = []
  if (zeroWidth) warnings.push(`含有 ${zeroWidth} 個零寬字元`)
  if (bidi) warnings.push(`含有 ${bidi} 個可能影響顯示次序的雙向控制字元`)
  const display = showInvisibles && total
    ? text.replace(INVISIBLES, character => `⟦${codePointLabel(character)}⟧`)
    : text
  return { display, warnings }
}
