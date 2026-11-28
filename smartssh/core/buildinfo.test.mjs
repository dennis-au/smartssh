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
t('optional valid sha256 is kept verbatim and does not change the version chip', () => {
  const sha256 = 'aB0123456789cDeF'.repeat(4)
  const info = parseBuildInfo(JSON.stringify({ ...JSON.parse(good), sha256 }))
  assert.strictEqual(info.sha256, sha256)
  assert.strictEqual(formatVersion(info), formatVersion(parseBuildInfo(good)))
})
t('invalid optional sha256 is omitted so the caller can hash the executable', () => {
  for (const sha256 of ['', 'g'.repeat(64), ['a'.repeat(64)], null]) {
    assert.deepStrictEqual(parseBuildInfo(JSON.stringify({ ...JSON.parse(good), sha256 })), parseBuildInfo(good))
  }
})
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
t('local.<n> is accepted, arbitrary build strings are not', () => {
  const local = '{"base":"1.0.238","build":"local.7","commit":"54869e1"}'
  assert.deepStrictEqual(parseBuildInfo(local), { base: '1.0.238', build: 'local.7', commit: '54869e1' })
  assert.strictEqual(formatVersion(parseBuildInfo(local)), '1.0.238 · local.7 · 54869e1')
  assert.strictEqual(parseBuildInfo('{"base":"1.0.238","build":"dev","commit":"54869e1"}'), null)
  assert.strictEqual(parseBuildInfo('{"base":"1.0.238","build":"sms.x","commit":"54869e1"}'), null)
})
t('local commit parses and is preserved in the version chip', () => {
  const info = parseBuildInfo('{"base":"1.0.238","build":"local.7","commit":"local"}')
  assert.deepStrictEqual(info, { base: '1.0.238', build: 'local.7', commit: 'local' })
  assert.strictEqual(formatVersion(info), '1.0.238 · local.7 · local')
})
t('unknown and short commit values still return null', () => {
  for (const commit of ['unknown0', 'abc']) {
    assert.strictEqual(parseBuildInfo(JSON.stringify({ base: '1.0.238', build: 'local.7', commit })), null, commit)
  }
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
