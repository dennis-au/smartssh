import assert from 'node:assert/strict'
import { auditUnmasked } from './audit.mjs'

const pemHeader = '-----BEGIN OPENSSH PRIVATE KEY-----'
const token = 'sk-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const tests = [
  ['ignores findings when every secret starts inside a mask', () => {
    const pairs = [
      ['', pemHeader], ['', token], ['', 'ghp_01234567'], ['', 'AKIA01234567'],
      ['', 'xoxb-0123-567'], ['Bearer ', 'fixture-bearer'], ['PassWORD for user: ', 'hunter2'],
      ['APP_TOKEN="', 'fixture-token'],
    ]
    let text = ''
    const masks = pairs.map(([prefix, value]) => {
      const srcStart = text.length + prefix.length
      text += `${prefix}${value}\n`
      return { srcStart, srcEnd: srcStart + value.length }
    })
    assert.deepEqual(auditUnmasked(text, masks), [])
  }],
  ['finds a prefixed PEM header with no mask', () => {
    assert.deepEqual(auditUnmasked(`line-8 ${pemHeader}`, []), [
      { kind: 'private_key', index: 7, sample: pemHeader.slice(0, 24) },
    ])
  }],
  ['finds an sk prefix embedded in a longer token', () => {
    assert.deepEqual(auditUnmasked(`outer${token}`, []), [{ kind: 'sk', index: 5, sample: token.slice(0, 24) }])
  }],
  ['checks only the start of each finding against half-open masks', () => {
    const text = `. ${token} ghp_01234567`
    const ghpIndex = 3 + token.length
    assert.deepEqual(auditUnmasked(text, [
      { srcStart: 2, srcEnd: 3 }, { srcStart: 4, srcEnd: ghpIndex },
    ]), [{ kind: 'ghp', index: ghpIndex, sample: 'ghp_01234567' }])
  }],
  ['returns findings in source order rather than rule order', () => {
    assert.deepEqual(auditUnmasked(`${token} ${pemHeader}`, []).map(({ kind }) => kind), ['sk', 'private_key'])
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
