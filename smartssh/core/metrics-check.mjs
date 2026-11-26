// contract: v44
// metrics-check.mjs — assertion side of the UI measurement file.
//   node smartssh/core/metrics-check.mjs --metrics data/metrics.json [--buildinfo extras/smartssh-buildinfo.json]
// exit 0 = no FAIL (skips allowed), 2 = at least one FAIL, 1 = could not read/parse.
import { readFileSync } from 'node:fs'
import { parseMetrics, judgeMetrics, summarise } from './metrics.mjs'
import { parseBuildInfo } from './buildinfo.mjs'

const args = process.argv.slice(2)
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
const metricsPath = arg('--metrics')
const buildinfoPath = arg('--buildinfo')
if (!metricsPath) { console.error('usage: --metrics <path> [--buildinfo <path>]'); process.exit(1) }

let text
try { text = readFileSync(metricsPath, 'utf8') } catch (e) { console.error('cannot read metrics:', e.message); process.exit(1) }
const parsed = parseMetrics(text)
if (parsed.error) { console.error('metrics invalid:', parsed.error); process.exit(1) }

let buildInfo = null
if (buildinfoPath) {
  try { buildInfo = parseBuildInfo(readFileSync(buildinfoPath, 'utf8')) } catch { buildInfo = null }
}

const results = judgeMetrics(parsed.metrics, buildInfo)
for (const r of results) console.log(`${r.status.padEnd(8)} ${r.name}  ${r.detail}`)
const s = summarise(results)
console.log(`\n${s.pass} pass / ${s.fail} fail / ${s.skip} skipped`)
// "nothing judged" is a failure, not a pass
process.exit((s.fail || s.pass === 0) ? 2 : 0)
