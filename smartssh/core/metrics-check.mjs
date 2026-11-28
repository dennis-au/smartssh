// contract: v53
// metrics-check.mjs — assertion side of the UI measurement file.
//   node smartssh/core/metrics-check.mjs --metrics data/metrics.json [--buildinfo extras/smartssh-buildinfo.json] [--exe-sha <sha256> | --exe <path>]
// exit 0 = no FAIL (skips allowed), 2 = at least one FAIL, 1 = unreadable or invalid input.
import { readFileSync } from 'node:fs'
import { computeExeSha } from '../app/exeSha.mjs'
import { parseMetrics, judgeMetrics, summarise, countLive, SHA256_RE } from './metrics.mjs'
import { parseBuildInfo } from './buildinfo.mjs'

const args = process.argv.slice(2)
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
const metricsPath = arg('--metrics')
const buildinfoPath = arg('--buildinfo')
if (!metricsPath) { console.error('usage: --metrics <path> [--buildinfo <path>] [--exe-sha <sha256> | --exe <path>]'); process.exit(1) }

let exeSha = arg('--exe-sha')
if (args.includes('--exe-sha') && !SHA256_RE.test(exeSha ?? '')) {
  console.error('exe sha256 must be 64 hex:', exeSha)
  process.exit(1)
}
if (args.includes('--exe')) {
  const exePath = arg('--exe')
  const fileSha = computeExeSha(exePath)
  if (!fileSha) { console.error('cannot hash exe: unreadable or missing path:', exePath); process.exit(1) }
  if (exeSha && exeSha.toUpperCase() !== fileSha) {
    console.error('--exe-sha does not match --exe:', exeSha, 'vs', fileSha)
    process.exit(1)
  }
  exeSha = fileSha
}

let text
try { text = readFileSync(metricsPath, 'utf8') } catch (e) { console.error('cannot read metrics:', e.message); process.exit(1) }
const parsed = parseMetrics(text)
if (parsed.error) { console.error('metrics invalid:', parsed.error); process.exit(1) }

let buildInfo = null
if (buildinfoPath) {
  try { buildInfo = parseBuildInfo(readFileSync(buildinfoPath, 'utf8')) } catch { buildInfo = null }
}

if (exeSha) buildInfo = { ...buildInfo, sha256: exeSha }

const results = judgeMetrics(parsed.metrics, buildInfo)
for (const r of results) console.log(`${r.status.padEnd(8)} ${r.name}  ${r.detail}`)
// A failing run must name the rule that failed: "0 pass / 0 fail" plus a live count is what let a
// zero-measurement file read as green for two releases.
const failures = results.filter(r => r.status === 'FAIL')
if (failures.length) {
  console.log(`\nJUDGE FAILED (${failures.length}):`)
  for (const r of failures) console.log(`  JUDGE FAIL: ${r.name}  ${r.detail}`)
}
const s = summarise(results)
console.log(`\n${s.pass} pass / ${s.fail} fail / ${s.skip} skipped`)
console.log(`live measurements: ${countLive(parsed.metrics)}/${parsed.metrics.cases.length} (measured:true only; declared cases excluded)`)
// "nothing judged" is a failure, not a pass
process.exit((s.fail || s.pass === 0) ? 2 : 0)
