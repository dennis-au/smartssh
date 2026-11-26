import assert from 'node:assert/strict'
import { auditInconsistent, auditSpans, auditUnmasked } from './audit.mjs'
import { redact } from './redact.mjs'

const sourceMasks = text => redact(text).masks.map(({ srcSpan }) => ({ srcStart: srcSpan.start, srcEnd: srcSpan.end }))

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
  ['a leading invisible in a bearer value is covered in both domains', () => {
    const label = '🔐 Authorization: Bearer '
    const text = `${label}\u200Bfixture-bearer`
    const masks = sourceMasks(text)
    assert.deepEqual(auditUnmasked(text, masks), [])
    assert.deepEqual(auditInconsistent(text, masks), [])
    assert.deepEqual(auditSpans(text, masks), [
      { kind: 'bearer', index: label.length, end: text.length, covered: true },
    ])
  }],
  ['normalisation recovers a split assignment label', () => {
    const label = '🔐 to\u200Bken='
    const text = `${label}fixture-token`
    const finding = { kind: 'env_key', index: label.length, end: text.length, covered: false }
    assert.deepEqual(auditUnmasked(text, []), [finding])
    const masks = sourceMasks(text)
    assert.deepEqual(auditSpans(text, masks), [{ ...finding, covered: true }])
    assert.deepEqual(auditUnmasked(text, masks), [])
    assert.deepEqual(auditInconsistent(text, masks), [])
  }],
  ['a mask covering only one domain is inconsistent in either direction', () => {
    const text = 'Bearer \u200Bfixture-bearer'
    const index = 'Bearer '.length
    for (const [srcStart, srcEnd, covered] of [[index, index + 1, true], [index + 1, text.length, false]]) {
      const masks = [{ srcStart, srcEnd }]
      assert.deepEqual(auditUnmasked(text, masks), covered ? [] : [{ kind: 'bearer', index, end: text.length, covered }])
      assert.deepEqual(auditInconsistent(text, masks), [{ kind: 'bearer', index, end: text.length, covered }])
    }
  }],
  ['a PEM mask covers the header and a nested password value', () => {
    const text = `${pemHeader}\nPassword: hunter3\n-----END OPENSSH PRIVATE KEY-----`
    const { masks } = redact(text)
    assert.deepEqual(masks.map(({ rule }) => rule), ['private_key'])
    const source = masks.map(({ srcSpan: { start, end } }) => ({ srcStart: start, srcEnd: end }))
    const index = text.indexOf('hunter3')
    assert.deepEqual(auditSpans(text, source), [
      { kind: 'private_key', index: 0, end: pemHeader.length, covered: true },
      { kind: 'password_prompt', index, end: index + 'hunter3'.length, covered: true },
    ])
    assert.deepEqual(auditUnmasked(text, source), [])
    assert.deepEqual(auditInconsistent(text, source), [])
  }],
  ['a password prompt finding spans the entire value', () => {
    const label = 'Password: '
    const value = 'fixture with spaces'
    assert.deepEqual(auditUnmasked(`${label}${value}\nnext`, []), [
      { kind: 'password_prompt', index: label.length, end: label.length + value.length, covered: false },
    ])
  }],
  ['finds a prefixed PEM header with no mask', () => {
    const text = `line-8 ${pemHeader}`
    const findings = [{ kind: 'private_key', index: 7, end: text.length, covered: false }]
    assert.deepEqual(auditSpans(text, []), findings)
    assert.deepEqual(auditUnmasked(text, []), findings)
  }],
  ['finds known prefixes at token boundaries', () => {
    const text = `outer${token} (${token})`
    assert.deepEqual(auditUnmasked(text, []), [
      { kind: 'sk', index: token.length + 7, end: text.length - 1, covered: false },
    ])
  }],
  ['finds assignment suffixes in lowercase, uppercase, and mixed case exactly once', () => {
    const value = 'abcdefgh12345678'
    for (const label of ['token', 'api_key', 'api-key', 'secret', 'client_secret', 'client-secret', 'passwd', 'pwd',
      'db_password', 'mySecretKey', 'AWS_SECRET_ACCESS_KEY', 'TOKEN', 'API_KEY']) {
      const text = `${label}=${value}`
      const finding = { kind: 'env_key', index: label.length + 1, end: text.length, covered: false }
      assert.deepEqual(auditUnmasked(text, []), [finding], label)
      assert.deepEqual(auditSpans(text, sourceMasks(text)), [{ ...finding, covered: true }], label)
    }
  }],
  ['assignment findings start at the value after whitespace and an opening quote', () => {
    const label = 'docker run -e api-key = "'
    const value = 'abcdefgh'
    const text = `${label}${value}"`
    assert.deepEqual(auditUnmasked(text, []), [
      { kind: 'env_key', index: label.length, end: text.length - 1, covered: false },
    ])
    assert.deepEqual(auditUnmasked(text, [{ srcStart: label.length, srcEnd: label.length + value.length }]), [])
  }],
  ['ignores empty and short assignments, including prose and quoted values', () => {
    for (const text of ['# token= is documented', 'token=', 'token=""', 'token=x', 'token=1234567', 'token="1234567"']) {
      assert.deepEqual(auditUnmasked(text, []), [], text)
    }
  }],
  ['all other rules recognize alternate casing', () => {
    for (const [kind, text] of [
      ['private_key', pemHeader.toLowerCase()], ['sk', 'SK-abc_12-3'], ['ghp', 'GHP_abc_12-3'],
      ['akia', 'akiaabc_12-3'], ['xoxb', 'XOXB-abc_12-3'], ['bearer', 'bEaReR\tabcdefgh'],
      ['password_prompt', '  db_PaSsWoRd: abcdefgh'],
    ]) {
      assert.deepEqual(auditUnmasked(text, []).map(finding => finding.kind), [kind], text)
    }
  }],
  ['checks only the start of each finding against half-open masks', () => {
    const text = `. ${token} ghp_01234567`
    const ghpIndex = 3 + token.length
    assert.deepEqual(auditUnmasked(text, [
      { srcStart: 2, srcEnd: 3 }, { srcStart: 4, srcEnd: ghpIndex },
    ]), [{ kind: 'ghp', index: ghpIndex, end: text.length, covered: false }])
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
