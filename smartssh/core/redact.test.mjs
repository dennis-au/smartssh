import assert from 'node:assert/strict'
import { RULES, redact } from './redact.mjs'

const canaries = [
  ['env_key', 'APP_TOKEN="secret-env"', 'APP_TOKEN="***"'],
  ['bearer', 'Authorization: Bearer secret-header==', 'Authorization: Bearer ***'],
  ['url_cred', 'https://alice:secret-url@example.com/path', 'https://***@example.com/path'],
  ['cli_password', 'login --password=secret-cli --verbose', 'login --password=*** --verbose'],
  ['known_prefix', 'token ghp_example suffix', 'token *** suffix'],
  ['private_key', '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-key\n-----END OPENSSH PRIVATE KEY-----', '***'],
  ['password_prompt', 'Password:\nsecret-input with spaces', '***'],
]
const allCanaries = canaries.map(([, input]) => input).join('\n')

let passes = 0
let fails = 0
const test = (name, run) => {
  try {
    run()
    console.log(`PASS ${name}`)
    passes++
  } catch (e) {
    console.log(`FAIL ${name} :: ${e.message}`)
    fails++
  }
}

test('rule ids are exact and ordered', () => {
  assert.deepEqual(RULES, ['env_key', 'bearer', 'url_cred', 'cli_password', 'known_prefix', 'private_key', 'password_prompt'])
})

test('each canary is masked by its own rule', () => {
  for (const [rule, input, expected] of canaries) {
    const result = redact(input)
    assert.equal(result.text, expected, rule)
    assert.deepEqual(result.masks.map(m => m.rule), [rule], rule)
  }
})

test('disabling any one rule leaves its canary unchanged and masks the others', () => {
  for (const disabled of RULES) {
    const enabled = RULES.filter(rule => rule !== disabled)
    const expected = canaries.map(([rule, input, masked]) => rule === disabled ? input : masked).join('\n')
    for (const selection of [enabled, new Set(enabled)]) {
      const result = redact(allCanaries, { enabled: selection })
      assert.equal(result.text, expected, disabled)
      assert.deepEqual(result.masks.map(m => m.rule), enabled, disabled)
    }
  }
  assert.deepEqual(redact(allCanaries, { enabled: [] }), { text: allCanaries, masks: [] })
})

test('two different secrets on one line yield two masks', () => {
  const result = redact('APP_KEY=secret-env login --password secret-cli --verbose')
  assert.equal(result.text, 'APP_KEY=*** login --password *** --verbose')
  assert.deepEqual(result.masks.map(m => m.rule), ['env_key', 'cli_password'])
})

test('mask offsets are into the returned text', () => {
  const result = redact(`🔐 ${allCanaries}`)
  assert.equal(result.masks.length, RULES.length)
  assert.equal(result.masks[0].start, '🔐 APP_TOKEN="'.length)
  for (const { start, end } of result.masks) assert.equal(result.text.slice(start, end), '***')
})

test('redacting masked output is a no-op', () => {
  const { text } = redact(allCanaries)
  assert.deepEqual(redact(text), { text, masks: [] })
})

test('clean text is returned unchanged', () => {
  const text = 'Connected to https://example.com\nPassword: not a standalone prompt\n  done.'
  assert.deepEqual(redact(text), { text, masks: [] })
})

test('null and undefined become empty text', () => {
  for (const input of [null, undefined]) assert.deepEqual(redact(input), { text: '', masks: [] })
})

test('environment suffixes and known prefixes are all recognized', () => {
  const env = redact("APP_KEY=one APP_TOKEN=two APP_SECRET='three' APP_PASSWORD=four")
  assert.equal(env.text, "APP_KEY=*** APP_TOKEN=*** APP_SECRET='***' APP_PASSWORD=***")
  assert.deepEqual(env.masks.map(m => m.rule), Array(4).fill('env_key'))
  const prefixes = redact('sk-fixture ghp_fixture AKIAFIXTURE xoxb-fixture ssh-rsa AAAAFIXTURE== comment')
  assert.equal(prefixes.text, '*** *** *** *** *** comment')
  assert.deepEqual(prefixes.masks.map(m => m.rule), Array(5).fill('known_prefix'))
})

test('quoted CLI values retain their quotes and overlapping rules mask once', () => {
  const result = redact('Authorization: Bearer sk-fixture --password "two words" --verbose')
  assert.equal(result.text, 'Authorization: Bearer *** --password "***" --verbose')
  assert.deepEqual(result.masks.map(m => m.rule), ['bearer', 'cli_password'])
})

test('multiline rules preserve surrounding lines and PEM labels must match', () => {
  const input = 'before\r\n-----BEGIN RSA PRIVATE KEY-----\r\nfixture\r\n-----END RSA PRIVATE KEY-----\r\nkeep\r\n  Password: \r\ntwo words\r\nafter'
  const result = redact(input)
  assert.equal(result.text, 'before\r\n***\r\nkeep\r\n***\r\nafter')
  assert.deepEqual(result.masks.map(m => m.rule), ['private_key', 'password_prompt'])
  const mismatch = input.split('\r\nkeep')[0].replace('END RSA', 'END OPENSSH')
  assert.deepEqual(redact(mismatch), { text: mismatch, masks: [] })
})

console.log(`${passes}/${passes + fails} passed`)
process.exit(fails ? 1 : 0)
