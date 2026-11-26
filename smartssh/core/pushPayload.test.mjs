// contract: v53
import assert from 'node:assert/strict'
import { previewDisplay } from './preview.mjs'
import { buildContextPush, maskBufferLine, MAX_LINES, TRIGGERS } from './pushPayload.mjs'

const at = '2025-01-02T03:04:05.000Z'

const sample = () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
  lines[9] = 'DEMO_TOKEN=example-token'
  return { trigger: 'manual', tab_id: 'tab-1', host: 'example.test', range: { fromLine: 101, toLine: 110, at }, lines }
}

const largeSample = () => {
  const lines = Array.from({ length: 250 }, (_, i) => `L${i}`)
  return { ...sample(), lines, range: { fromLine: 51, toLine: 250, at } }
}

const pem = [
  '-----BEGIN PRIVATE KEY-----',
  'fixture-part-one',
  'fixture-part-two',
  'fixture-part-three',
  '-----END PRIVATE KEY-----',
]

const withLines = lines => ({ ...sample(), lines, range: { fromLine: 51, toLine: 50 + lines.length, at } })

const triggerError = { message: 'context.push requires trigger manual|l|ask|hermes_request' }
const rangeError = { message: 'range does not match the number of lines sent' }
const assertMaskSlices = ({ text, masks }) => {
  for (const { start, end } of masks) assert.equal(text.slice(start, end), '***')
}

const tests = [
  ['manual push masks one secret and preserves metadata', () => {
    const input = sample()
    const payload = buildContextPush(input)
    assert.equal(payload.trigger, 'manual')
    assert.equal(payload.tab_id, input.tab_id)
    assert.equal(payload.host, input.host)
    assert.deepEqual(payload.range, input.range)
    assert.equal(payload.line_count, 10)
    assert.equal(payload.text, input.lines.join('\n').replace('example-token', '***'))
    assert.equal(payload.masks.length, 1)
    assert.equal(payload.redacted_segments, payload.masks.length)
    assertMaskSlices(payload)
  }],
  ['single-line env_key mask covers one source line', () => {
    const { masks } = buildContextPush(sample())
    assert.equal(masks[0].rule, 'env_key')
    assert.equal(masks[0].srcLines, 1)
  }],
  ['missing trigger throws', () => {
    const input = sample()
    delete input.trigger
    assert.throws(() => buildContextPush(input), triggerError)
  }],
  ['unknown trigger throws', () => {
    assert.throws(() => buildContextPush({ ...sample(), trigger: 'auto' }), triggerError)
  }],
  ['all four explicit triggers are accepted', () => {
    assert.deepEqual(TRIGGERS, ['manual', 'l', 'ask', 'hermes_request'])
    for (const trigger of TRIGGERS) assert.equal(buildContextPush({ ...sample(), trigger }).trigger, trigger)
  }],
  ['keeps the last 200 lines and reports 50 omitted', () => {
    const input = largeSample()
    const payload = buildContextPush({ ...input, text: input.lines.join('\n') })
    assert.equal(MAX_LINES, 200)
    assert.equal(payload.line_count, 200)
    assert.deepEqual(payload.range, input.range)
    assert.equal(payload.truncated_lines, 50)
    assert.deepEqual(payload.text.split('\n'), input.lines.slice(50))
    assert.equal(input.lines.length, 250)
  }],
  ['an uncovered secret only in the 50 dropped lines does not block a push', () => {
    const input = largeSample()
    input.lines[49] = `log: ${pem[0]}` // No closing delimiter, so this would fail the audit if sent.
    const payload = buildContextPush(input)
    assert.equal(payload.truncated_lines, 50)
    assert.equal(payload.redacted_segments, 0)
    assert.deepEqual(payload.text.split('\n'), input.lines.slice(50))
    input.lines[50] = input.lines[49]
    assert.throws(() => buildContextPush(input), { code: 'AUDIT_UNCOVERED' })
  }],
  ['ignores legacy text even when it has 999 lines', () => {
    const lines = ['first', 'second', 'third']
    const push = buildContextPush({ ...withLines(lines), text: Array(999).fill('bogus').join('\n') })
    assert.equal(push.line_count, 3)
    assert.deepEqual(push.text.split('\n'), lines)
  }],
  ['five-line PEM collapses to a single mask', () => {
    const push = buildContextPush(withLines(['before', ...pem, 'after']))
    assert.equal(push.text, 'before\n***\nafter')
    assert.equal(push.line_count, 7)
    assert.equal(push.redacted_segments, 1)
    assert.equal(push.redacted_segments, push.masks.length)
    assert.equal(push.masks.length, 1)
    assert.equal(push.masks[0].rule, 'private_key')
    assert.equal(push.masks[0].srcLines, 5)
  }],
  ['PEM containing a password is one redacted segment', () => {
    const push = buildContextPush(withLines([`line-8 ${pem[0]}`, 'Password: hunter2', pem.at(-1)]))
    assert.equal(push.text, 'line-8 ***')
    assert.equal(push.redacted_segments, 1)
    assert.deepEqual(push.masks.map(({ rule }) => rule), ['private_key'])
  }],
  ['PEM at the start of the window maps to the first source line', () => {
    const push = buildContextPush(withLines([...pem, 'after']))
    const [mask] = push.masks
    assert.equal(mask.start, 0)
    assert.equal(mask.srcSpan.start, 0)
    assert.equal(mask.bufferLine, push.range.fromLine)
    assert.equal(mask.srcLines, 5)
  }],
  ['secret after collapsed PEM retains its source buffer line', () => {
    const input = largeSample()
    input.lines.splice(50, pem.length + 1, ...pem, 'DEMO_TOKEN=example-token')
    const push = buildContextPush(input)
    assert.deepEqual(push.masks.map(({ rule, bufferLine }) => [rule, bufferLine]), [
      ['private_key', 51],
      ['env_key', 56],
    ])
    assert.equal(maskBufferLine(push, push.masks[1]), 56)
    assertMaskSlices(push)
  }],
  ['push has no raw window or undefined values and carries complete masks', () => {
    const push = buildContextPush(withLines([...pem, 'DEMO_TOKEN=example-token']))
    const keys = Object.keys(push)
    for (const key of ['lines', 'windowText', 'lines_redacted']) assert.ok(!keys.includes(key))
    assert.ok(keys.includes('line_count'))
    assert.deepEqual(push, JSON.parse(JSON.stringify(push)))
    assert.equal(push.masks.length, 2)
    for (const mask of push.masks) {
      assert.deepEqual(Object.keys(mask).sort(), ['bufferLine', 'end', 'invisibleInside', 'rule', 'srcLines', 'srcSpan', 'start'])
      assert.equal(mask.invisibleInside, 0)
    }
  }],
  ['serialized payload does not carry the raw bearer canary', () => {
    const canary = 'CANARY_bearer_fixture_7890'
    const payload = buildContextPush(withLines(['a', `Authorization: Bearer ${canary}`, 'c']))
    assert.equal(payload.text, 'a\nAuthorization: Bearer ***\nc')
    assert.ok(!JSON.stringify(payload).includes(canary))
  }],
  ['a leading invisible in a bearer value builds with deception severity', () => {
    const payload = buildContextPush(withLines(['Authorization: Bearer \u200Bfixture-bearer']))
    assert.equal(payload.text, 'Authorization: Bearer ***')
    assert.equal(payload.masks[0].invisibleInside, 1)
    assert.equal(payload.invisible_escalation, 1)
    assert.equal(payload.severity, 'deception')
  }],
  ['serialized payload hides the split token and its mask escalates severity', () => {
    const suffix = 'CANARY_split_fixture_7890'
    const canary = `ghp_\u200B${suffix}`
    const payload = buildContextPush(withLines(['a\u200Bb', canary, 'c']))
    assert.equal(payload.text, 'a\u200Bb\n***\nc')
    const serialized = JSON.stringify(payload)
    assert.ok(!serialized.includes(canary))
    assert.ok(!serialized.includes(suffix))
    assert.deepEqual(payload.masks.map(({ invisibleInside }) => invisibleInside), [1])
    assert.equal(payload.invisible_escalation, 1)
    assert.equal(payload.severity, 'deception')
  }],
  ['escalation counts masks, not their individual invisibles', () => {
    const payload = buildContextPush(withLines(['ghp_\u200B\u200Bfixture', 'sk-\u200Bfixture', 'AKIAfixture']))
    assert.deepEqual(payload.masks.map(({ invisibleInside }) => invisibleInside), [2, 1, 0])
    assert.equal(payload.invisible_escalation, 2)
    assert.equal(payload.severity, 'deception')
  }],
  ['an emoji ZWJ alone does not increase severity', () => {
    const payload = buildContextPush(withLines(['👩‍💻']))
    assert.equal(payload.invisible_escalation, 0)
    assert.equal(payload.severity, 'none')
  }],
  ['range off by one throws', () => {
    assert.throws(() => buildContextPush({ ...sample(), range: { fromLine: 101, toLine: 109, at } }), rangeError)
  }],
  ['range matching the original 250 lines throws', () => {
    assert.throws(() => buildContextPush({ ...largeSample(), range: { fromLine: 1, toLine: 250, at } }), rangeError)
  }],
  ['range without at throws', () => {
    const input = sample()
    delete input.range.at
    assert.throws(() => buildContextPush(input), { message: 'range.at is required' })
  }],
  ['every trigger returns range.at for ISO strings and integer milliseconds', () => {
    for (const timestamp of [at, Date.parse(at), 0]) {
      for (const trigger of TRIGGERS) {
        const input = sample()
        input.range.at = timestamp
        assert.equal(buildContextPush({ ...input, trigger }).range.at, timestamp)
      }
    }
  }],
  ['invalid timestamps throw', () => {
    for (const timestamp of ['', 'not a date', '1234', 1.5]) {
      const input = sample()
      input.range.at = timestamp
      assert.throws(() => buildContextPush(input), /range\.at must be/)
    }
  }],
  ['range coordinates must be 1-based integers in order', () => {
    assert.throws(() => buildContextPush({ ...sample(), range: { fromLine: 0, toLine: 9, at } }), /range\.fromLine/)
    for (const range of [{ fromLine: 0, toLine: 199, at }, { fromLine: '51', toLine: 250, at }]) {
      assert.throws(() => buildContextPush({ ...largeSample(), range }), { message: 'range.fromLine is 1-based' })
    }
    assert.throws(() => buildContextPush({ ...sample(), range: { fromLine: 101, toLine: 100, at } }), /range\.toLine/)
    assert.throws(() => buildContextPush({ ...sample(), range: { fromLine: 101.5, toLine: 110.5, at } }), /range\.fromLine/)
    assert.throws(() => buildContextPush({ ...sample(), range: { fromLine: 101, toLine: '110', at } }), /range\.toLine/)
  }],
  ...[250, 51].map(bufferLine => [`mask on buffer line ${bufferLine} maps back to that line`, () => {
    const input = largeSample()
    input.lines[bufferLine - 1] = 'DEMO_TOKEN=example-token'
    const push = buildContextPush(input)
    assert.equal(push.masks.length, 1)
    assert.equal(maskBufferLine(push, push.masks[0]), bufferLine)
  }]),
  ['mask without srcSpan throws', () => {
    assert.throws(() => maskBufferLine(buildContextPush(sample()), {}), { message: 'mask has no srcSpan' })
  }],
  ['mask without a computed buffer line requires windowText', () => {
    assert.throws(() => maskBufferLine(buildContextPush(sample()), { srcSpan: { start: 0 } }), { message: 'push has no windowText' })
  }],
  ['mask starting on a line beyond the sent window throws', () => {
    const push = { windowText: 'sent\noutside', lines: ['sent'], range: { fromLine: 51, toLine: 51, at } }
    assert.throws(() => maskBufferLine(push, { srcSpan: { start: 5 } }), { message: 'mask starts outside the sent window' })
  }],
  ['empty tab_id throws', () => {
    assert.throws(() => buildContextPush({ ...sample(), tab_id: '' }), /tab_id/)
  }],
  ['empty host throws', () => {
    assert.throws(() => buildContextPush({ ...sample(), host: '' }), /host/)
  }],
  ['lowercase token assignments are masked before the payload is serialized', () => {
    const canary = 'abcdefgh12345678'
    const payload = buildContextPush(withLines([`token=${canary}`]))
    assert.equal(payload.text, 'token=***')
    assert.deepEqual(payload.masks.map(({ rule }) => rule), ['env_key'])
    assert.ok(!JSON.stringify(payload).includes(canary))
  }],
  ['the audit blocks a missed credential without putting it in the error message', () => {
    // The redactor recognizes uppercase AKIA; the independent audit also catches lowercase.
    const canary = 'akiafixture12345678'
    assert.throws(() => buildContextPush(withLines([canary])), error => {
      assert.equal(error.code, 'AUDIT_UNCOVERED')
      assert.equal(error.message, 'audit found an unmasked secret-like span')
      assert.ok(!error.message.includes(canary))
      assert.deepEqual(error.findings.map(({ kind }) => kind), ['akia'])
      return true
    })
  }],
  ['unlabeled hex, UUID, and base64 are detail-only signals', () => {
    const hex = '0123456789abcdef0123456789abcdef'
    const base64 = 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXphYmNkZWY='
    const uuid = '01234567-89ab-cdef-0123-456789abcdef'
    for (const token of [hex, uuid, base64, `${hex.slice(0, 16)}\u200B${hex.slice(16)}`]) {
      const payload = buildContextPush(withLines([token]))
      assert.equal(payload.text, token)
      assert.equal(payload.high_entropy_count, 1)
      assert.deepEqual(previewDisplay(payload).warnings.filter(({ kind }) => kind === 'banner'), [])
    }
    const payload = buildContextPush(withLines([hex]))
    assert.equal(payload.severity, 'none')
    assert.deepEqual(previewDisplay(payload).warnings, [{ kind: 'detail', text: '另見 1 個疑似高熵字串' }])
    assert.equal(buildContextPush(withLines([`token=${hex}`, `AKIA${hex}`])).high_entropy_count, 0)
    assert.throws(() => buildContextPush({ ...withLines([`token=${hex}`]), enabledRules: [] }), { code: 'AUDIT_UNCOVERED' })
  }],
  ['coverage disagreement wins over an uncovered credential', () => {
    // A bare Bearer label does not trigger the redactor's Authorization rule.
    // The prefix rule masks the visible value but not the leading invisible.
    const text = 'Bearer \u200Bghp_01234567'
    assert.throws(() => buildContextPush(withLines([text, pem[0]])), {
      code: 'AUDIT_INCONSISTENT',
      message: 'audit and redactor disagree about coverage',
      findings: [{ kind: 'bearer', index: 'Bearer '.length, end: text.length, covered: false }],
    })
  }],
  ['disabling a rule does not bypass the audit', () => {
    assert.throws(() => buildContextPush({ ...sample(), enabledRules: [] }), { code: 'AUDIT_UNCOVERED' })
  }],
  ['two secrets produce two coherent masks', () => {
    const input = sample()
    input.lines[0] = 'Authorization: Bearer example-bearer'
    const payload = buildContextPush(input)
    assert.equal(payload.text, input.lines.join('\n').replace('example-bearer', '***').replace('example-token', '***'))
    assert.equal(payload.redacted_segments, 2)
    assert.equal(payload.masks.length, 2)
    assertMaskSlices(payload)
  }],
  ['an invisible separator does not hide the next export in the payload', () => {
    const line = 'export A_KEY=fixture-a\u200Bexport B_KEY=fixture-b'
    const payload = buildContextPush(withLines([line, 'echo keep']))
    assert.equal(payload.text, 'export A_KEY=***export B_KEY=***\necho keep')
    assert.equal(payload.redacted_segments, 2)
    assert.deepEqual(payload.masks.map(({ invisibleInside }) => invisibleInside), [1, 0])
    assert.deepEqual(payload.masks.map(({ srcSpan }) => line.slice(srcSpan.start, srcSpan.end)), ['fixture-a\u200B', 'fixture-b'])
    assertMaskSlices(payload)
  }],
  ['all counters are present even when zero', () => {
    const payload = buildContextPush(withLines(['echo keep']))
    for (const key of ['truncated_lines', 'redacted_segments', 'invisible_escalation', 'high_entropy_count']) {
      assert.ok(Object.hasOwn(payload, key))
      assert.equal(payload[key], 0)
    }
  }],
]

let passed = 0
for (const [name, test] of tests) {
  try {
    test()
    passed++
    console.log(`PASS ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}`, error)
  }
}
console.log(`${passed}/${tests.length} passed`)
if (passed !== tests.length) process.exitCode = 1
