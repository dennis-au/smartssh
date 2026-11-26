// contract: v53
// Deliberately independent of the redactor's rules and matching domains.
// For labeled credentials, the finding starts at the value, not the label
// that the redactor intentionally preserves.
const PATTERNS = [
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/dg],
  ['sk', /sk-[A-Za-z0-9]{8,}/dg],
  ['ghp', /ghp_[A-Za-z0-9]{8,}/dg],
  ['akia', /AKIA[0-9A-Z]{8,}/dg],
  ['xoxb', /xoxb-[A-Za-z0-9-]{8,}/dg],
  ['bearer', /Bearer[ \t]+(\S{8,})/dg],
  ['password_prompt', /password[^:\n]*:[ \t]*(\S+)/dgi],
  ['env_key', /[A-Za-z_]*(?:KEY|TOKEN|SECRET|PASSWORD)=(\S{8,})/dg],
]

export function auditUnmasked (text, masks) {
  const findings = []
  for (const [kind, pattern] of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const [start, end] = match.indices[1] ?? match.indices[0]
      const quoted = kind === 'env_key' && (text[start] === '"' || text[start] === "'")
      const index = start + Number(quoted)
      if (!masks.some(m => index >= m.srcStart && index < m.srcEnd)) {
        findings.push({ kind, index, sample: text.slice(index, Math.min(end, index + 24)) })
      }
    }
  }
  return findings.sort((a, b) => a.index - b.index)
}
