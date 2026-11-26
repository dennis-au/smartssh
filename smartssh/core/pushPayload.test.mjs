// contract: v40
import assert from 'node:assert/strict'
import { buildContextPush, MAX_LINES, TRIGGERS } from './pushPayload.mjs'

const sample = () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
  lines[9] = 'DEMO_TOKEN=example-token'
  return { trigger: 'manual', tab_id: 'tab-1', host: 'example.test', range: { fromLine: 101, toLine: 110 }, lines, text: lines.join('\n') }
}

const largeSample = () => {
  const lines = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`)
  return { ...sample(), lines, range: { fromLine: 51, toLine: 250 }, text: lines.slice(-200).join('\n') }
}

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
    assert.equal(payload.text, input.text.replace('example-token', '***'))
    assert.equal(payload.masks.length, 1)
    assert.equal(payload.redacted_segments, payload.masks.length)
    assertMaskSlices(payload)
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
    const payload = buildContextPush(input)
    assert.equal(MAX_LINES, 200)
    assert.equal(payload.lines.length, 200)
    assert.equal(payload.truncated_lines, 50)
    assert.deepEqual(payload.lines, input.lines.slice(50))
    assert.equal(input.lines.length, 250)
  }],
  ['range off by one throws', () => {
    assert.throws(() => buildContextPush({ ...sample(), range: { fromLine: 101, toLine: 109 } }), rangeError)
  }],
  ['range matching the original 250 lines throws', () => {
    assert.throws(() => buildContextPush({ ...largeSample(), range: { fromLine: 1, toLine: 250 } }), rangeError)
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
    assert.equal(payload.text, input.text)
    assert.deepEqual(payload.masks, [])
    assert.equal(payload.redacted_segments, 0)
  }],
  ['two secrets produce two coherent masks', () => {
    const input = sample()
    input.lines[0] = 'Authorization: Bearer example-bearer'
    input.text = input.lines.join('\n')
    const payload = buildContextPush(input)
    assert.equal(payload.text, input.text.replace('example-bearer', '***').replace('example-token', '***'))
    assert.equal(payload.redacted_segments, 2)
    assert.equal(payload.masks.length, 2)
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
