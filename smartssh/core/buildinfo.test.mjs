import assert from 'node:assert'
import { parseBuildInfo, formatVersion, stripBom } from './buildinfo.mjs'
const r = []; const t = (n, f) => { try { f(); r.push(['PASS', n]) } catch (e) { r.push(['FAIL', n + ' :: ' + e.message]) } }
const good = '{"base":"1.0.238","build":"sms.42","commit":"54869e1","builtAt":"2026-11-26T11:50:46Z"}'
const BOM = '\uFEFF'

t('clean JSON parses', () => assert.deepStrictEqual(parseBuildInfo(good), { base: '1.0.238', build: 'sms.42', commit: '54869e1', builtAt: '2026-11-26T11:50:46Z' }))
t('BOM-prefixed JSON parses identically (the CI bug that showed "dev")', () =>
  assert.deepStrictEqual(parseBuildInfo(BOM + good), parseBuildInfo(good)))
t('BOM + surrounding whitespace still parses', () =>
  assert.deepStrictEqual(parseBuildInfo('\n' + BOM + good + '\n'), parseBuildInfo(good)))
t('formatVersion gives the three-part chip', () =>
  assert.strictEqual(formatVersion(parseBuildInfo(BOM + good)), '1.0.238 · sms.42 · 54869e1'))
t('bad JSON => null (UI shows dev, never a fake string)', () => {
  assert.strictEqual(parseBuildInfo('{oops'), null)
  assert.strictEqual(parseBuildInfo(''), null)
  assert.strictEqual(parseBuildInfo(null), null)
  assert.strictEqual(formatVersion(null), 'dev')
})
t('missing or malformed fields => null', () => {
  assert.strictEqual(parseBuildInfo('{"base":"1.0.238","build":"sms.42"}'), null)
  assert.strictEqual(parseBuildInfo('{"base":"v1.0.238","build":"sms.42","commit":"54869e1"}'), null)
  assert.strictEqual(parseBuildInfo('{"base":"1.0.238","build":"42","commit":"54869e1"}'), null)
  assert.strictEqual(parseBuildInfo('{"base":"1.0.238","build":"sms.42","commit":"zzz"}'), null)
})
t('a 64-hex token smuggled into a field is rejected (commit must be 7..40 hex)', () => {
  const sneaky = '{"base":"1.0.238","build":"sms.42","commit":"' + 'a'.repeat(64) + '"}'
  assert.strictEqual(parseBuildInfo(sneaky), null)
})
t('stripBom only removes a leading BOM', () => {
  assert.strictEqual(stripBom(BOM + 'x'), 'x')
  assert.strictEqual(stripBom('x' + BOM), 'x' + BOM)
  assert.strictEqual(stripBom(undefined), '')
})
for (const [s, n] of r) console.log(`${s}  ${n}`)
const f = r.filter(x => x[0] === 'FAIL').length
console.log(`\n${r.length - f}/${r.length} passed`)
process.exit(f ? 1 : 0)
