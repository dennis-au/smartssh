import assert from 'node:assert/strict'
import { MULTILINE_RULES, RULES, maskSrcLines, redact, stripInvisible } from './redact.mjs'

const canaries = [
  ['env_key', 'APP_TOKEN="secret-env"', 'APP_TOKEN="***"', 'secret-env'],
  ['bearer', 'Authorization: Bearer secret-header==', 'Authorization: Bearer ***', 'secret-header=='],
  ['url_cred', 'https://alice:secret-url@example.com/path', 'https://***@example.com/path', 'alice:secret-url'],
  ['cli_password', 'login --password=secret-cli --verbose', 'login --password=*** --verbose', 'secret-cli'],
  ['known_prefix', 'token ghp_example suffix', 'token *** suffix', 'ghp_example'],
  ['private_key', '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-key\n-----END OPENSSH PRIVATE KEY-----', '***', 'secret-key'],
  ['password_prompt', 'Password: secret-input with spaces', 'Password: ***', 'secret-input with spaces'],
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

test('canary masks have separate output and non-overlapping source coordinates', () => {
  const input = `🔐 ${allCanaries}`
  const { text, masks } = redact(input)
  assert.deepEqual(masks.map(m => m.rule), RULES)
  let previousEnd = 0
  for (const [i, { rule, start, end, srcSpan }] of masks.entries()) {
    assert.equal(text.slice(start, end), '***', rule)
    const source = input.slice(srcSpan.start, srcSpan.end)
    assert.ok(source.includes(canaries[i][3]), rule)
    assert.ok(!source.includes('***'), rule)
    assert.ok(previousEnd <= srcSpan.start, rule)
    previousEnd = srcSpan.end
  }
})

test('redacting masked output is a no-op', () => {
  const { text } = redact(allCanaries)
  assert.deepEqual(redact(text), { text, masks: [] })
})

test('clean text is returned unchanged', () => {
  const text = 'Connected to https://example.com\nPassword:\n  done.'
  assert.deepEqual(redact(text), { text, masks: [] })
})

test('null and undefined become empty text', () => {
  for (const input of [null, undefined]) assert.deepEqual(redact(input), { text: '', masks: [] })
})

test('assignment labels are case-insensitive and allow bare, dashed, and camel-case suffixes', () => {
  const value = 'abcdefgh12345678'
  for (const label of ['token', 'api_key', 'api-key', 'secret', 'client_secret', 'client-secret', 'passwd', 'pwd',
    'db_password', 'mySecretKey', 'AWS_SECRET_ACCESS_KEY', 'TOKEN', 'API_KEY', 'apikey']) {
    const input = `${label}=${value}`
    const result = redact(input)
    assert.equal(result.text, `${label}=***`, label)
    assert.deepEqual(result.masks.map(m => m.rule), ['env_key'], label)
    assert.equal(singleMaskSource(input, result), value, label)
  }
})

test('an assignment label split by an invisible still masks its value', () => {
  const input = '🔐 to\u200Bken=fixture-token'
  const result = redact(input)
  assert.equal(result.text, '🔐 to\u200Bken=***')
  assertMaskTokens(input, result, ['fixture-token'])
})

test('a leading invisible in a bearer value belongs to the mask', () => {
  const input = 'Authorization: Bearer \u200Bfixture-bearer'
  const result = redact(input)
  assert.equal(result.text, 'Authorization: Bearer ***')
  assert.equal(singleMaskSource(input, result), '\u200Bfixture-bearer')
  assert.equal(result.masks[0].invisibleInside, 1)
})

test('empty credential values and bare prefixes never create masks', () => {
  for (const text of ['token=', 'api_key= ', 'Password:', 'sk-']) {
    assert.deepEqual(redact(text), { text, masks: [] })
  }
})

test('empty assignments and plural suffixes stay unchanged, but short nonempty values mask', () => {
  for (const text of ['token=', 'token=""', 'sorted_keys=abc']) {
    assert.deepEqual(redact(text), { text, masks: [] })
  }
  for (const value of ['x', 'abc']) {
    const result = redact(`token =${value}`)
    assert.equal(result.text, 'token =***')
    assert.deepEqual(result.masks.map(m => m.rule), ['env_key'])
  }
})

test('environment suffixes and known prefixes are all recognized', () => {
  const env = redact("APP_KEY=one APP_TOKEN=two APP_SECRET='three' APP_PASSWORD=four")
  assert.equal(env.text, "APP_KEY=*** APP_TOKEN=*** APP_SECRET='***' APP_PASSWORD=***")
  assert.deepEqual(env.masks.map(m => m.rule), Array(4).fill('env_key'))
  const prefixes = redact('sk-fixture ghp_fixture AKIAFIXTURE xoxb-fixture ssh-rsa AAAAFIXTURE== comment')
  assert.equal(prefixes.text, '*** *** *** *** *** comment')
  assert.deepEqual(prefixes.masks.map(m => m.rule), Array(5).fill('known_prefix'))
})

test('stripInvisible removes exactly the listed code points and maps UTF-16 offsets', () => {
  const removed = '\u200B\u200C\u200D\u200E\u200F\u00AD\uFEFF\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069'
  const retained = '\u200A\u2010\u2029\u202F\u2065\u206A\uFEFE'
  assert.deepEqual(stripInvisible(`😀${removed}${retained}`), {
    stripped: `😀${retained}`,
    map: [0, 1, ...Array.from(retained, (_, i) => 2 + removed.length + i)],
  })
})

for (const invisible of ['\u200B', '\u200D', '\u202E']) {
  const label = `U+${invisible.charCodeAt(0).toString(16).toUpperCase()}`
  test(`all five token prefixes mask through ${label}`, () => {
    for (const [context, prefix] of [
      ['token ', 'ghp_'], ['key ', 'sk-'], ['aws ', 'AKIA'],
      ['slack ', 'xoxb-'], ['Authorization: Bearer ', ''],
    ]) {
      const token = `${prefix}CAN${invisible}ARY`
      const input = `🔐 ${context}${token} suffix`
      const result = redact(input)
      assert.equal(result.masks.length, 1, context)
      assert.equal(result.masks.length, redact(stripInvisible(input).stripped).masks.length, context)
      assert.equal(singleMaskSource(input, result), token, context)
      assert.equal(result.text, `🔐 ${context}*** suffix`, context)
      assert.deepEqual(redact(result.text), { text: result.text, masks: [] }, context)
    }
  })
}

test('an invisible inside a prefix does not prevent matching', () => {
  const input = 'token g\u200Bhp_CANARY'
  assert.equal(singleMaskSource(input, redact(input)), 'g\u200Bhp_CANARY')
})

// The contract changed in v52: extend over adjacent invisibles, never merge.
test('two secrets separated by an invisible character stay two masks', () => {
  const input = '--password=first!\u200Dghp_second'
  const result = redact(input)
  assert.equal(result.text, '--password=******')
  assert.deepEqual(result.masks.map(m => m.rule), ['cli_password', 'known_prefix'])
  assert.equal(result.masks[0].srcSpan.end, result.masks[1].srcSpan.start)
  assert.deepEqual(result.masks.map(m => m.invisibleInside), [1, 0])
  assertMaskTokens(input, result, ['first!', 'ghp_second'])
})

test('an invisible separator cannot mask any part of the next assignment', () => {
  for (const command of ['', 'export ']) {
    const first = 'export A_KEY=fixture-a'
    const next = `${command}B_KEY=fixture-b`
    const input = `${first}\u200B${next}`
    const result = redact(input)
    assert.equal(result.text, `export A_KEY=***${command}B_KEY=***`)
    assert.equal(result.masks.length, 2)
    const { start, end } = result.masks[0].srcSpan
    assert.equal(end, first.length + 1)
    assert.equal(input.slice(start, end), 'fixture-a\u200B')
    assertMaskTokens(input, result, ['fixture-a', 'fixture-b'])
  }
})

test('a known prefix with an invisible inside includes it in the mask', () => {
  const token = 'ghp_\u200Bfixture'
  const input = `token ${token} suffix`
  const result = redact(input)
  assert.equal(singleMaskSource(input, result), token)
  assert.equal(result.masks[0].invisibleInside, 1)
  assert.equal(result.masks.length, redact(stripInvisible(input).stripped).masks.length)
})

test('three secrets separated by two invisibles stay disjoint', () => {
  const input = 'A_KEY=first\u200BB_KEY=second\u202EC_KEY=third'
  const result = redact(input)
  assert.equal(result.text, 'A_KEY=***B_KEY=***C_KEY=***')
  assert.deepEqual(result.masks.map(m => m.invisibleInside), [1, 1, 0])
  assertMaskTokens(input, result, ['first', 'second', 'third'])
})

test('clean emoji ZWJ sequences are preserved without masks', () => {
  const text = 'Family: 👨‍👩‍👧'
  assert.deepEqual(redact(text), { text, masks: [] })
})

// The contract changed in v52: extend over adjacent invisibles, never merge.
test('quoted CLI values retain their quotes and duplicate matches count once', () => {
  const input = 'Authorization: Bearer sk-fixture\u200B --password "two words" --verbose'
  const result = redact(input)
  assert.equal(result.text, 'Authorization: Bearer *** --password "***" --verbose')
  // Identical spans match bearer and known_prefix; bearer is first in pattern order.
  assert.deepEqual(result.masks.map(m => m.rule), ['bearer', 'cli_password'])
  assertMaskTokens(input, result, ['sk-fixture', 'two words'])
})

test('all eight high-risk combinations preserve the matched token in each source span', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----'
  const cases = [
    ['env_key', '😀 A_KEY=secret\u200Bexport', 'secret'],
    ['bearer', 'Authorization: Bearer fix\u200Dture==\u200F next', 'fixture=='],
    ['url_cred', 'https://alice:sec\u202Eret@example.com/path', 'alice:secret'],
    ['cli_password', 'login --password=fixture\u200B--verbose', 'fixture'],
    ['cli_password', 'login --password "two words"\u200B--verbose', 'two words'],
    ['known_prefix', 'token ghp_\u200Bfixture\u2069 suffix', 'ghp_fixture'],
    ['private_key', pem.replace('fixture', 'fix\u200Bture') + '\u200B\nafter', pem],
    ['password_prompt', 'Password:\u200Btwo words\nnext', 'two words'],
  ]
  for (const [rule, input, token] of cases) {
    const result = redact(input)
    assert.deepEqual(result.masks.map(m => m.rule), [rule], rule)
    assertMaskTokens(input, result, [token])
  }
})

test('a boundary match that consumes a synthetic space fails the token equality check', () => {
  assert.throws(() => redact('login --password "two\u200Bwords"'), {
    message: 'mask span does not match the matched token',
  })
})

test('multiline rules preserve surrounding lines and PEM labels must match', () => {
  const input = 'before\r\n-----BEGIN RSA PRIVATE KEY-----\r\nfixture\r\n-----END RSA PRIVATE KEY-----\r\nkeep\r\n  Password: two words\r\nafter'
  const result = redact(input)
  assert.equal(result.text, 'before\r\n***\r\nkeep\r\n  Password: ***\r\nafter')
  assert.deepEqual(result.masks.map(m => m.rule), ['private_key', 'password_prompt'])
  const mismatch = input.split('\r\nkeep')[0].replace('END RSA', 'END OPENSSH')
  assert.deepEqual(redact(mismatch), { text: mismatch, masks: [] })
})

test('password prompts mask only the inline value', () => {
  for (const [label, value] of [['Password: ', 'hunter2'], ['[sudo] password for hermes: ', 'pw']]) {
    const result = redact(label + value)
    assert.deepEqual(result.masks, [{
      rule: 'password_prompt',
      start: label.length,
      end: label.length + 3,
      srcSpan: { start: label.length, end: label.length + value.length },
      invisibleInside: 0,
    }])
    const [{ start, end }] = result.masks
    assert.equal(result.text.slice(start, end), '***')
    assert.equal(result.text, `${label}***`)
    assert.ok(!result.text.includes(value))
  }
})

test('empty password prompts leave the next line untouched', () => {
  for (const text of ['Password:\nls -la /tmp', 'Password: \nls -la /tmp', 'Password: \r\nls -la /tmp']) {
    assert.deepEqual(redact(text), { text, masks: [] })
  }
})

test('config dump password masking preserves surrounding lines', () => {
  const result = redact('cat config.ini\n[db]\nPassword: hunter2\nhost=db1')
  assert.equal(result.text, 'cat config.ini\n[db]\nPassword: ***\nhost=db1')
  assert.deepEqual(result.masks.map(m => m.rule), ['password_prompt'])
})

function assertMaskTokens (input, { text, masks }, matchedTokens) {
  assert.equal(masks.length, matchedTokens.length)
  let previousSrcEnd = 0
  let previousEnd = 0
  for (const [i, { start, end, srcSpan }] of masks.entries()) {
    assert.ok(previousSrcEnd <= srcSpan.start)
    assert.ok(previousEnd <= start)
    assert.equal(text.slice(start, end), '***')
    assert.equal(stripInvisible(input.slice(srcSpan.start, srcSpan.end)).stripped,
      stripInvisible(matchedTokens[i]).stripped)
    previousSrcEnd = srcSpan.end
    previousEnd = end
  }
}

function singleMaskSource (input, { masks }) {
  assert.equal(masks.length, 1)
  const [{ srcSpan: { start, end } }] = masks
  return input.slice(start, end)
}

test('a whole PEM block is replaced by one multiline mask', () => {
  const body = ['fixture-key-line-one', 'fixture-key-line-two', 'fixture-key-line-three']
  const pem = ['-----BEGIN OPENSSH PRIVATE KEY-----', ...body, '-----END OPENSSH PRIVATE KEY-----'].join('\n')
  const input = `before\n${pem}\nafter`
  const result = redact(input)
  assert.deepEqual(result.masks.map(m => m.rule), ['private_key'])
  const source = singleMaskSource(input, result)
  assert.ok(source.includes('\n'))
  assert.equal(source, pem)
  assert.equal(maskSrcLines(input, result.masks[0]), 5)
  assert.equal(result.text, 'before\n***\nafter')
  for (const line of body) assert.ok(!result.text.includes(line))
})

test('PEM masks start at BEGIN regardless of the preceding text', () => {
  const pem = canaries.find(([rule]) => rule === 'private_key')[1]
  for (const prefix of ['', 'line-8 ', '+', '  ', '2026-11-26T14:21:00Z ', '$ cat id_rsa\n']) {
    const block = prefix === '+' ? pem.replaceAll('\n', '\n+') : pem
    const input = `${prefix}${block} tail`
    const result = redact(input)
    assert.deepEqual(result.masks.map(m => m.rule), ['private_key'], prefix)
    assert.deepEqual(result.masks[0].srcSpan, { start: prefix.length, end: prefix.length + block.length }, prefix)
    assert.equal(result.text, `${prefix}*** tail`, prefix)
  }
})

test('a PEM mask contains and replaces a nested password mask', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nPassword: hun\u200Bter2\n-----END PRIVATE KEY-----'
  const result = redact(`${pem}\u200B`)
  assert.deepEqual(result.masks.map(m => m.rule), ['private_key'])
  assert.equal(result.masks[0].invisibleInside, 2)
  assert.equal(result.text, '***')
})

test('partial overlap still throws', () => {
  const input = 'Password: prefix -----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----'
  assert.throws(() => redact(input), /redaction masks overlap/)
})

test('only private_key is whitelisted for multiline masks', () => {
  assert.deepEqual(MULTILINE_RULES, ['private_key'])
})

test('only the private_key canary produces a multiline source span', () => {
  for (const [rule, canary] of canaries) {
    const input = `before\n${canary}\nafter`
    assert.equal(singleMaskSource(input, redact(input)).includes('\n'), rule === 'private_key', rule)
  }
})

test('single-line rules cover exactly one source line', () => {
  const { masks } = redact(allCanaries)
  for (const mask of masks) {
    if (!MULTILINE_RULES.includes(mask.rule)) assert.equal(maskSrcLines(allCanaries, mask), 1, mask.rule)
  }
})

test('maskSrcLines throws when the mask has no source span', () => {
  assert.throws(() => maskSrcLines('secret', { rule: 'env_key', start: 0, end: 3 }), TypeError)
})

console.log(`${passes}/${passes + fails} passed`)
process.exit(fails ? 1 : 0)
