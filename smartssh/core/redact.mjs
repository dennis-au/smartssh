// contract: v40
// redact.mjs — find secret spans in terminal text without changing their surrounding syntax.
export const RULES = ['env_key', 'bearer', 'url_cred', 'cli_password', 'known_prefix', 'private_key', 'password_prompt']
export const MULTILINE_RULES = ['private_key']

const MASK = '***'
// Capture the replacement span separately from context. CLI quoting uses alternate captures.
const PATTERNS = {
  env_key: /\b[A-Za-z_]\w*_(?:KEY|TOKEN|SECRET|PASSWORD)=["']?([^\s"']+)/dg,
  bearer: /\bAuthorization:[ \t]*Bearer[ \t]+([A-Za-z0-9._~+/-]+=*)/dgi,
  url_cred: /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/([^\s:/@"'<>]+:[^\s/@"'<>]+)@(?=[A-Za-z0-9\[])/dg,
  cli_password: /(?<![\w-])--password(?:=|[ \t]+)(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))/dg,
  known_prefix: /\b((?:sk-|ghp_|AKIA|xoxb-)[A-Za-z0-9_-]+|ssh-rsa[ \t]+AAAA[A-Za-z0-9+/]*={0,2})/dg,
  private_key: /(^-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[ \t]*\r?\n[\s\S]*?^-----END \2-----)(?=[ \t]*$)/dgm,
  password_prompt: /^[ \t]*((?:\[sudo\][ \t]*)?password[^:\n]*:[ \t]*)(\S.*)$/dgim,
}

export function maskSrcLines (input, mask) {
  const { start, end } = mask.srcSpan
  return input.slice(start, end).split('\n').length
}

export function redact (text, opts = {}) {
  const input = String(text ?? '')
  const enabled = new Set(opts.enabled ?? RULES)
  const spans = []
  for (const [rule, pattern] of Object.entries(PATTERNS)) {
    if (!enabled.has(rule)) continue
    for (const match of input.matchAll(pattern)) {
      const [start, end] = rule === 'password_prompt'
        ? match.indices[2]
        : (match.indices[1] ?? match.indices[2] ?? match.indices[3])
      if (input.slice(start, end) !== MASK) spans.push({ rule, start, end })
    }
  }

  // Prefer the enclosing match (e.g. a bearer token with a known prefix).
  // Merge partial overlaps too so no part of either secret is left behind.
  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged = []
  for (const span of spans) {
    const prev = merged[merged.length - 1]
    if (prev && span.start < prev.end) prev.end = Math.max(prev.end, span.end)
    else merged.push(span)
  }

  // Check source spans before replacing them; returned offsets point at the replacement.
  for (const { rule, start, end } of merged) {
    if (input.slice(start, end).includes('\n') && !MULTILINE_RULES.includes(rule)) {
      throw new Error(`rule ${rule} produced a mask spanning a newline`)
    }
  }

  let output = ''
  let cursor = 0
  const masks = []
  for (const { rule, start, end } of merged) {
    output += input.slice(cursor, start)
    const offset = output.length
    output += MASK
    masks.push({ rule, start: offset, end: output.length, srcSpan: { start, end } })
    cursor = end
  }
  return { text: output + input.slice(cursor), masks }
}
