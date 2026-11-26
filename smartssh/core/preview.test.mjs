import assert from 'node:assert/strict'
import { buildContextPush } from './pushPayload.mjs'
import { payloadSeverity, previewText, scanInvisibles, previewDisplay } from './preview.mjs'

const build = (...lines) => buildContextPush({
  trigger: 'manual',
  tab_id: 'tab-1',
  host: 'example.test',
  range: { fromLine: 1, toLine: lines.length, at: 0 },
  lines,
})
const cleanScan = { zeroWidth: 0, bidi: 0, deception: 0, suspicious: 0, legitimate: 0, total: 0, rawTotal: 0, codePoints: [] }
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
  ['legitimate joiners do not contribute to any warning tier', () => {
    for (const [text, legitimate] of [['👨‍👩‍👧', 2], ['ع\u200Cب', 1], ['क\u200Dष', 1], ['a\u200Dé', 1], ['\u200Da', 1], ['a\u200C', 1]]) {
      assert.deepEqual(scanInvisibles(text), { ...cleanScan, zeroWidth: legitimate, legitimate, rawTotal: legitimate })
      assert.deepEqual(previewDisplay({ text }).warnings, [])
    }
  }],
  ['ASCII-flanked joiners count as deception and trigger a banner', () => {
    for (const [text, label] of [['a\u200Db', 'U+200D'], ['a\u200Cb', 'U+200C']]) {
      assert.deepEqual(scanInvisibles(text), {
        ...cleanScan, zeroWidth: 1, deception: 1, total: 1, rawTotal: 1, codePoints: [label],
      })
      assert.deepEqual(previewDisplay({ text }).warnings.map(warning => warning.kind), ['banner'])
    }
  }],
  ['U+200B triggers a detail warning even when placeholders are hidden', () => {
    const text = 'a\u200Bb'
    assert.deepEqual(scanInvisibles(text), {
      ...cleanScan, zeroWidth: 1, suspicious: 1, total: 1, rawTotal: 1, codePoints: ['U+200B'],
    })
    const hidden = previewDisplay({ text }, { showInvisibles: false })
    const shown = previewDisplay({ text }, { showInvisibles: true })
    assert.deepEqual(hidden.warnings.map(warning => warning.kind), ['detail'])
    assert.deepEqual(shown.warnings, hidden.warnings)
    assert.equal(hidden.display, text)
    assert.equal(shown.display, 'a⟦U+200B⟧b')
  }],
  ['a BOM is suspicious only away from the start', () => {
    assert.deepEqual(scanInvisibles('\uFEFFabc'), { ...cleanScan, zeroWidth: 1, legitimate: 1, rawTotal: 1 })
    assert.deepEqual(scanInvisibles('a\uFEFFb'), {
      ...cleanScan, zeroWidth: 1, suspicious: 1, total: 1, rawTotal: 1, codePoints: ['U+FEFF'],
    })
    assert.deepEqual(scanInvisibles('\uFEFFa\uFEFFb'), {
      ...cleanScan, zeroWidth: 2, suspicious: 1, legitimate: 1, total: 1, rawTotal: 2, codePoints: ['U+FEFF'],
    })
    assert.deepEqual(previewDisplay({ text: '\uFEFFa' }).warnings, [])
  }],
  ['bidi produces one banner with 顯示次序 and the count', () => {
    const text = 'a\u202Eb'
    assert.equal(scanInvisibles(text).bidi, 1)
    assert.equal(scanInvisibles(text).deception, 1)
    const { warnings } = previewDisplay({ text })
    assert.deepEqual(warnings.map(warning => warning.kind), ['banner'])
    assert.match(warnings[0].text, /1.*顯示次序/u)
  }],
  ['visible placeholders do not change the raw clipboard source', () => {
    const payload = { text: 'a\u202Eb' }
    assert.equal(previewDisplay(payload, { showInvisibles: true }).display, 'a⟦U+202E⟧b')
    assert.equal(previewText(payload), 'a\u202Eb')
  }],
  ['mixed counts include repeats but labels are unique and sorted', () => {
    assert.deepEqual(scanInvisibles('\u202E\u200B\u200B'), {
      ...cleanScan, zeroWidth: 2, bidi: 1, deception: 1, suspicious: 2, total: 3, rawTotal: 3, codePoints: ['U+200B', 'U+202E'],
    })
  }],
  ['mixed warnings and labels count only deception and suspicious occurrences', () => {
    const text = '\uFEFF👨‍👩‍👧 a\u200Cb\u202E\u200B\u200B\u00AD'
    const scan = scanInvisibles(text)
    assert.deepEqual(scan, {
      deception: 2, suspicious: 3, legitimate: 3, total: 5, rawTotal: 8, zeroWidth: 7, bidi: 1,
      codePoints: ['U+00AD', 'U+200B', 'U+200C', 'U+202E'],
    })
    assert.equal(scan.total, scan.deception + scan.suspicious)
    assert.equal(scan.rawTotal, scan.total + scan.legitimate)
    assert.deepEqual(previewDisplay({ text }).warnings, [
      { kind: 'banner', text: '含有 2 個可能隱藏內容或影響顯示次序的字元' },
      { kind: 'detail', text: '含有 3 個可疑的零寬字元' },
    ])
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
      zeroWidth: 5, bidi: 11, deception: 11, suspicious: 3, legitimate: 2, total: 14, rawTotal: 16,
      codePoints: [
        'U+00AD', 'U+200B', 'U+200E', 'U+200F',
        'U+202A', 'U+202B', 'U+202C', 'U+202D', 'U+202E', 'U+2066', 'U+2067', 'U+2068', 'U+2069', 'U+FEFF',
      ],
    })
    assert.ok(previewDisplay({ text }, { showInvisibles: true }).display.startsWith(clean + '⟦U+00AD⟧'))
  }],
  ['payload severity takes the worst of escalation and visible text', () => {
    for (const [payload, expected] of [
      [build('ghp_\u200Bfixture'), 'deception'],
      [build('ghp_\u200Bfixture', 'a\u200Bb'), 'deception'],
      [build('a\u200Bb\u202Ec'), 'deception'],
      [build('a\u200Db'), 'deception'],
      [build('ghp_fixture', 'a\u200Bb'), 'suspicious'],
      [build('👩‍💻'), 'none'],
    ]) {
      assert.equal(payload.severity, expected)
      const { text, invisible_escalation } = payload
      assert.equal(payloadSeverity({ text, invisible_escalation }), expected)
    }
    assert.equal(payloadSeverity({ text: '***', masks: [{ invisibleInside: 1 }], invisible_escalation: 0 }), 'none')
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
