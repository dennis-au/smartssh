import assert from 'node:assert/strict'
import { buildContextPush } from './pushPayload.mjs'
import { previewText, scanInvisibles, previewDisplay } from './preview.mjs'

const build = (...lines) => buildContextPush({
  trigger: 'manual',
  tab_id: 'tab-1',
  host: 'example.test',
  range: { fromLine: 1, toLine: lines.length, at: 0 },
  lines,
})
const cleanScan = { zeroWidth: 0, bidi: 0, total: 0, codePoints: [] }
const tests = [
  ['preview text equals the built payload text without normalization', () => {
    const payload = build('  cafe\u0301\r', 'emoji 😀  ')
    assert.equal(previewText(payload), payload.text)
    assert.equal(previewText(payload), '  cafe\u0301\r\nemoji 😀  ')
  }],
  ['preview text introduces no placeholder brackets', () => {
    assert.doesNotMatch(previewText(build('a\u200Bb\u202Ec')), /[⟦⟧]/u)
  }],
  ['display with invisibles off is identical to preview text', () => {
    const payload = build('a\u200Bb\u202Ec')
    const hidden = previewDisplay(payload, { showInvisibles: false })
    assert.equal(hidden.display, previewText(payload))
    assert.deepEqual(previewDisplay(payload), hidden)
  }],
  ['clean text produces zero counts and no warnings', () => {
    assert.deepEqual(scanInvisibles('clean 😀 text'), cleanScan)
    assert.deepEqual(previewDisplay({ text: 'clean 😀 text' }, { showInvisibles: true }), {
      display: 'clean 😀 text', warnings: [],
    })
  }],
  ['U+200B counts as one zero-width character', () => {
    assert.deepEqual(scanInvisibles('a\u200Bb'), {
      zeroWidth: 1, bidi: 0, total: 1, codePoints: ['U+200B'],
    })
  }],
  ['bidi warning includes 顯示次序 and the count', () => {
    const text = 'a\u202Eb'
    assert.equal(scanInvisibles(text).bidi, 1)
    assert.ok(previewDisplay({ text }).warnings.some(warning => /1.*顯示次序|顯示次序.*1/u.test(warning)))
  }],
  ['visible placeholders do not change the raw clipboard source', () => {
    const payload = { text: 'a\u202Eb' }
    assert.equal(previewDisplay(payload, { showInvisibles: true }).display, 'a⟦U+202E⟧b')
    assert.equal(previewText(payload), 'a\u202Eb')
  }],
  ['mixed counts include repeats but labels are unique and sorted', () => {
    assert.deepEqual(scanInvisibles('\u202E\u200B\u200B'), {
      zeroWidth: 2, bidi: 1, total: 3, codePoints: ['U+200B', 'U+202E'],
    })
  }],
  ['empty text produces a zero-count result', () => {
    assert.deepEqual(scanInvisibles(''), cleanScan)
  }],
  ['the raw clipboard source preserves a mask alongside bidi text', () => {
    const payload = build('prefix \u202E', 'DEMO_TOKEN=example-token')
    assert.equal(previewDisplay(payload, { showInvisibles: true }).display, 'prefix ⟦U+202E⟧\nDEMO_TOKEN=***')
    const text = previewText(payload)
    assert.equal(text, 'prefix \u202E\nDEMO_TOKEN=***')
    assert.equal(payload.masks.length, 1)
    const [{ start, end }] = payload.masks
    assert.equal(text.slice(start, end), '***')
  }],
  ['all specified characters are recognized and nearby ones are left alone', () => {
    const clean = '\u200A\u2010\u2029\u202F\u2065\u206A\uFEFE'
    const zeroWidth = '\u00AD\u200B\u200C\u200D\u200E\u200F\uFEFF'
    const bidi = '\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069'
    const text = clean + zeroWidth + bidi
    assert.deepEqual(scanInvisibles(text), {
      zeroWidth: 7, bidi: 9, total: 16,
      codePoints: [
        'U+00AD', 'U+200B', 'U+200C', 'U+200D', 'U+200E', 'U+200F',
        'U+202A', 'U+202B', 'U+202C', 'U+202D', 'U+202E', 'U+2066', 'U+2067', 'U+2068', 'U+2069', 'U+FEFF',
      ],
    })
    assert.ok(previewDisplay({ text }, { showInvisibles: true }).display.startsWith(clean + '⟦U+00AD⟧'))
  }],
  ['non-string payload text throws instead of coercing', () => {
    assert.throws(() => previewText({ text: 42 }), { message: 'preview payload has no text' })
  }],
]

let passed = 0
for (const [name, run] of tests) {
  try {
    run()
    passed++
    console.log(`PASS ${name}`)
  } catch (error) {
    console.log(`FAIL ${name}: ${error.message}`)
  }
}
console.log(`${passed}/${tests.length} passed`)
if (passed !== tests.length) process.exitCode = 1
