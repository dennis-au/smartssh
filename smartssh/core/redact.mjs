// contract: v53
// redact.mjs — find secret spans in terminal text without changing their surrounding syntax.
export const RULES = ['env_key', 'bearer', 'url_cred', 'cli_password', 'known_prefix', 'private_key', 'password_prompt']
export const MULTILINE_RULES = ['private_key']

const MASK = '***'
const INVISIBLE = /[\u200B\u200C\u200D\u200E\u200F\u00AD\uFEFF\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069]/u
const INVISIBLES = new RegExp(INVISIBLE, 'gu')

export function isInvisible (char) {
  return INVISIBLE.test(char)
}

export function stripInvisible (text) {
  let stripped = ''
  const map = []
  // RegExp match indices are UTF-16 offsets, including both units of a surrogate pair.
  for (let i = 0; i < text.length; i++) {
    if (isInvisible(text[i])) continue
    stripped += text[i]
    map.push(i)
  }
  return { stripped, map }
}
// Capture the replacement span separately from context. CLI quoting uses alternate captures.
const ENV_ASSIGNMENT = /[A-Za-z_]\w*_(?:KEY|TOKEN|SECRET|PASSWORD)=/
const PATTERNS = {
  env_key: new RegExp(`\\b${ENV_ASSIGNMENT.source}["']?([^\\s"']+)`, 'dg'),
  bearer: /\bAuthorization:[ \t]*Bearer[ \t]+([A-Za-z0-9._~+/-]+=*)/dgi,
  url_cred: /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/([^\s:/@"'<>]+:[^\s/@"'<>]+)@(?=[A-Za-z0-9\[])/dg,
  cli_password: /(?<![\w-])--password(?:=|[ \t]+)(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))/dg,
  known_prefix: /\b((?:sk-|ghp_|AKIA|xoxb-)[A-Za-z0-9_-]+|ssh-rsa[ \t]+AAAA[A-Za-z0-9+/]*={0,2})/dg,
  private_key: /(^-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[ \t]*\r?\n[\s\S]*?^-----END \2-----)(?=[ \t]*$)/dgm,
  password_prompt: /^[ \t]*((?:\[sudo\][ \t]*)?password[^:\n]*:[ \t]*)(\S.*)$/dgim,
}

// A rule that matches \S or .*$ must run in domain B; a rule that matches a
// charset token may run in domain T.
const BOUNDARY_RULES = new Set(['env_key', 'cli_password', 'password_prompt'])

export function maskSrcLines (input, mask) {
  const { start, end } = mask.srcSpan
  return input.slice(start, end).split('\n').length
}

export function assertDisjointMasks (masks, text) {
  const sorted = [...masks].sort((a, b) => a.start - b.start)
  for (let i = 1; i < sorted.length; i++) {
    const m = sorted[i]
    if (m.start < sorted[i - 1].end) {
      const src = Math.max(0, m.start - 8)
      throw new Error(`redaction masks overlap at offset ${m.start} in: ${JSON.stringify(text.slice(src, m.start + 8))}`)
    }
  }
}

export function redact (text, opts = {}) {
  const input = String(text ?? '')
  const enabled = new Set(opts.enabled ?? RULES)
  const { stripped: tokenDomain, map: tokenToSource } = stripInvisible(input)
  const boundaryDomain = input.replace(INVISIBLES, ' ')
  const spans = []
  const seenSpans = new Set()
  for (const [rule, pattern] of Object.entries(PATTERNS)) {
    if (!enabled.has(rule)) continue
    const inBoundaryDomain = BOUNDARY_RULES.has(rule)
    const subject = inBoundaryDomain ? boundaryDomain : tokenDomain
    for (const match of subject.matchAll(pattern)) {
      const capture = rule === 'password_prompt' ? 2 : (match[1] != null ? 1 : (match[2] != null ? 2 : 3))
      const [matchStart, matchEnd] = match.indices[capture]
      const matchedToken = match[capture]
      if (matchStart === matchEnd || matchedToken === MASK) continue
      const start = inBoundaryDomain ? matchStart : tokenToSource[matchStart]
      const end = inBoundaryDomain ? matchEnd : tokenToSource[matchEnd - 1] + 1
      const key = `${start}:${end}`
      // Exact duplicates are the same secret: keep the first rule, never union spans.
      if (seenSpans.has(key)) continue
      seenSpans.add(key)
      spans.push({ rule, start, end, matchedToken })
    }
  }

  spans.sort((a, b) => a.start - b.start)
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]
    const limit = spans[i + 1]?.start ?? input.length
    // Keep the boxes separate; trailing invisibles belong to the earlier match.
    while (span.end < limit && isInvisible(input[span.end])) span.end++
    const source = input.slice(span.start, span.end)
    const { stripped } = stripInvisible(source)
    if (stripped !== stripInvisible(span.matchedToken).stripped) {
      throw new Error('mask span does not match the matched token')
    }
    span.invisibleInside = source.length - stripped.length
    if (source.includes('\n') && !MULTILINE_RULES.includes(span.rule)) {
      throw new Error(`rule ${span.rule} produced a mask spanning a newline`)
    }
  }

  // Check source spans before replacing them; returned offsets point at the replacement.
  assertDisjointMasks(spans, input)

  let output = ''
  let cursor = 0
  const masks = []
  for (const { rule, start, end, invisibleInside } of spans) {
    output += input.slice(cursor, start)
    const offset = output.length
    output += MASK
    masks.push({ rule, start: offset, end: output.length, srcSpan: { start, end }, invisibleInside })
    cursor = end
  }
  output += input.slice(cursor)
  assertDisjointMasks(masks, output)
  return { text: output, masks }
}
