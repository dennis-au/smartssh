// contract: v41
import assert from 'node:assert/strict'
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
    assert.deepEqual(payload.lines, input.lines)
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
    assert.equal(payload.lines.length, 200)
    assert.equal(payload.lines[0], 'L50')
    assert.equal(payload.truncated_lines, 50)
    assert.deepEqual(payload.lines, input.lines.slice(50))
    assert.deepEqual(payload.text.split('\n'), input.lines.slice(50))
    assert.equal(input.lines.length, 250)
  }],
  ['ignores legacy text even when it has 999 lines', () => {
    const lines = ['first', 'second', 'third']
    const push = buildContextPush({ ...withLines(lines), text: Array(999).fill('bogus').join('\n') })
    assert.deepEqual(push.text.split('\n'), lines)
  }],
  ['five-line PEM collapses to a single mask', () => {
    const push = buildContextPush(withLines(['before', ...pem, 'after']))
    assert.equal(push.text, 'before\n***\nafter')
    assert.ok(push.text.split('\n').length < push.lines.length)
    assert.equal(push.redacted_segments, 1)
    assert.equal(push.redacted_segments, push.masks.length)
    assert.equal(push.masks.length, 1)
    assert.equal(push.masks[0].rule, 'private_key')
    assert.equal(push.masks[0].srcLines, 5)
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
  ['push has no windowText or undefined values and carries complete masks', () => {
    const push = buildContextPush(withLines([...pem, 'DEMO_TOKEN=example-token']))
    assert.ok(!Object.hasOwn(push, 'windowText'))
    assert.deepEqual(push, JSON.parse(JSON.stringify(push)))
    assert.equal(push.masks.length, 2)
    for (const mask of push.masks) {
      assert.deepEqual(Object.keys(mask).sort(), ['bufferLine', 'end', 'invisibleInside', 'rule', 'srcLines', 'srcSpan', 'start'])
      assert.equal(mask.invisibleInside, 0)
    }
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
  ['empty enabledRules disables masking', () => {
    const input = sample()
    const payload = buildContextPush({ ...input, enabledRules: [] })
    assert.equal(payload.text, input.lines.join('\n'))
    assert.deepEqual(payload.masks, [])
    assert.equal(payload.redacted_segments, 0)
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
  ['both counters are present even when zero', () => {
    const payload = buildContextPush({ ...sample(), enabledRules: [] })
    for (const key of ['truncated_lines', 'redacted_segments']) {
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
