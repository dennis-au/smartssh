// smartssh/app/portablePath.test.mjs — the read-only branch is the one that ships broken
// (a silent %LOCALAPPDATA% write only shows up on a Windows box with an ACL-locked folder), so it
// gets the most coverage here. Run: node smartssh/app/portablePath.test.mjs
import assert from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    resolveUserDataPath, normalizePortableDir, portableDataDir, probeWritableDir, PORTABLE_REASON,
} from './portablePath.mjs'

const r = []
const t = (n, f) => { try { f(); r.push(['PASS', n]) } catch (e) { r.push(['FAIL', n + ' :: ' + e.message]) } }

const WIN_FALLBACK = 'C:\\Users\\me\\AppData\\Roaming\\SmartSSH'
const POSIX_FALLBACK = '/home/me/.config/SmartSSH'
// Explicit tmp roots so a posix-platform case never inherits a Windows-shaped os.tmpdir() (which
// would make the expected value a '/'+'\' mix) and vice versa.
const WIN_TMP = 'C:\\SmartSSHTemp'
const POSIX_TMP = '/var/tmp/smartssh-test'

// Windows' own os.tmpdir() is %LOCALAPPDATA%\Temp, so "must not contain AppData" is only a
// meaningful assertion with an injected tmpDir; a separate case proves the fallback userData is
// never returned even when tmpdir is left at its default.

t('win32 portable + writable => <portable>/data (trailing backslash trimmed)', () => {
    const out = resolveUserDataPath({
        portableDir: 'D:\\Apps\\SmartSSH\\',
        isWritable: true,
        platform: 'win32',
        fallbackUserData: WIN_FALLBACK,
    })
    assert.strictEqual(out.path, 'D:\\Apps\\SmartSSH\\data')
    assert.deepStrictEqual(
        [out.portable, out.writable, out.readOnlyMode, out.reason],
        [true, true, false, PORTABLE_REASON.PORTABLE_WRITABLE])
})

t('win32 accepts forward slashes and mixed case separators => one canonical path', () => {
    const out = resolveUserDataPath({
        portableDir: 'D:/Apps/SmartSSH/',
        isWritable: true,
        platform: 'win32',
        fallbackUserData: WIN_FALLBACK,
    })
    assert.strictEqual(out.path, 'D:\\Apps\\SmartSSH\\data')
})

t('linux portable + writable => <portable>/data (posix separators)', () => {
    const out = resolveUserDataPath({
        portableDir: '/opt/smartssh///',
        isWritable: true,
        platform: 'linux',
        fallbackUserData: POSIX_FALLBACK,
    })
    assert.strictEqual(out.path, '/opt/smartssh/data')
    assert.strictEqual(out.readOnlyMode, false)
})

t('win32 portable + NOT writable => tmpdir/smartssh-ro, no AppData, not the fallback', () => {
    const out = resolveUserDataPath({
        portableDir: 'E:\\ro\\SmartSSH',
        isWritable: false,
        platform: 'win32',
        fallbackUserData: WIN_FALLBACK,
        tmpDir: 'C:\\SmartSSHTemp',
    })
    assert.strictEqual(out.path, 'C:\\SmartSSHTemp\\smartssh-ro')
    assert.ok(!/AppData/i.test(out.path), 'read-only path must not land in AppData: ' + out.path)
    assert.ok(!/LOCALAPPDATA/i.test(out.path))
    assert.notStrictEqual(out.path, WIN_FALLBACK)
    assert.deepStrictEqual(
        [out.portable, out.writable, out.readOnlyMode, out.reason],
        [true, false, true, PORTABLE_REASON.PORTABLE_READ_ONLY])
})

t('linux portable + NOT writable => <tmpdir>/smartssh-ro (posix join, injected tmpdir)', () => {
    const out = resolveUserDataPath({
        portableDir: '/mnt/cdrom/smartssh',
        isWritable: false,
        platform: 'linux',
        fallbackUserData: POSIX_FALLBACK,
        tmpDir: POSIX_TMP,
    })
    assert.strictEqual(out.path, path.posix.join(POSIX_TMP, 'smartssh-ro'))
    assert.ok(!out.path.startsWith('/home/me/.config'), 'must not fall back to userData')
    assert.strictEqual(out.readOnlyMode, true)
})

t('read-only NEVER returns the Electron userData path (the %LOCALAPPDATA% fallback ban)', () => {
    for (const platform of ['win32', 'linux', 'darwin']) {
        const fallback = platform === 'win32' ? WIN_FALLBACK : POSIX_FALLBACK
        const tmpDir = platform === 'win32' ? WIN_TMP : POSIX_TMP
        const out = resolveUserDataPath({ portableDir: 'X:\\ro', isWritable: false, platform, fallbackUserData: fallback, tmpDir })
        assert.notStrictEqual(out.path, fallback)
        assert.ok(!out.path.includes('SmartSSH') || out.path.endsWith('smartssh-ro'), 'unexpected path ' + out.path)
        assert.strictEqual(out.readOnlyMode, true)
        assert.strictEqual(out.writable, false)
    }
})

t('no portableDir => fallbackUserData unchanged, portable=false (dev/installed behaviour)', () => {
    for (const [platform, fallback] of [['win32', WIN_FALLBACK], ['linux', POSIX_FALLBACK], ['darwin', POSIX_FALLBACK]]) {
        const out = resolveUserDataPath({ portableDir: undefined, platform, fallbackUserData: fallback })
        assert.strictEqual(out.path, fallback)
        assert.deepStrictEqual(
            [out.portable, out.writable, out.readOnlyMode, out.reason],
            [false, true, false, PORTABLE_REASON.NO_PORTABLE_DIR])
    }
})

t('empty / whitespace / null portableDir is treated as absent, not as <cwd>/data', () => {
    for (const portableDir of ['', '   ', null]) {
        const out = resolveUserDataPath({ portableDir, isWritable: true, platform: 'linux', fallbackUserData: POSIX_FALLBACK })
        assert.strictEqual(out.path, POSIX_FALLBACK, 'portableDir=' + JSON.stringify(portableDir))
        assert.strictEqual(out.portable, false)
    }
})

t('UNC path stays UNC when writable', () => {
    const out = resolveUserDataPath({
        portableDir: '\\\\fileserver\\share\\SmartSSH\\',
        isWritable: true,
        platform: 'win32',
        fallbackUserData: WIN_FALLBACK,
    })
    assert.strictEqual(out.path, '\\\\fileserver\\share\\SmartSSH\\data')
    assert.ok(out.path.startsWith('\\\\fileserver\\share'), 'UNC prefix lost: ' + out.path)
})

t('UNC path + read-only => tmp fallback, still not the userData path', () => {
    const out = resolveUserDataPath({
        portableDir: '\\\\fileserver\\share\\SmartSSH',
        isWritable: false,
        platform: 'win32',
        fallbackUserData: WIN_FALLBACK,
        tmpDir: 'C:\\SmartSSHTemp',
    })
    assert.strictEqual(out.path, 'C:\\SmartSSHTemp\\smartssh-ro')
    assert.ok(!out.path.startsWith('\\\\fileserver'), 'read-only must not try the read-only share')
})

t('missing fallbackUserData without a portableDir throws instead of inventing a path', () => {
    assert.throws(() => resolveUserDataPath({ portableDir: null, platform: 'win32' }), TypeError)
    assert.throws(() => resolveUserDataPath({ portableDir: '  ', fallbackUserData: '   ', platform: 'win32' }), TypeError)
    assert.throws(() => resolveUserDataPath(), TypeError)
})

t('normalizePortableDir keeps drive/posix roots and strips repeats', () => {
    assert.strictEqual(normalizePortableDir('C:\\', 'win32'), 'C:\\')
    assert.strictEqual(normalizePortableDir('/', 'linux'), '/')
    assert.strictEqual(normalizePortableDir('  D:\\Apps\\\\  ', 'win32'), 'D:\\Apps')
    assert.strictEqual(normalizePortableDir(undefined, 'win32'), null)
})

t('portableDataDir is exactly the path the resolver returns when writable', () => {
    for (const [portableDir, platform] of [['D:\\Apps\\SmartSSH\\', 'win32'], ['/opt/smartssh/', 'linux'], ['\\\\srv\\share\\a', 'win32']]) {
        const probe = portableDataDir(portableDir, platform)
        const out = resolveUserDataPath({ portableDir, isWritable: true, platform, fallbackUserData: 'F' })
        assert.strictEqual(out.path, probe)
    }
})

t('result records are frozen (no accidental mutation by callers)', () => {
    const out = resolveUserDataPath({ portableDir: '/opt/smartssh', isWritable: true, platform: 'linux', fallbackUserData: POSIX_FALLBACK })
    assert.ok(Object.isFrozen(out))
    assert.throws(() => { 'use strict'; out.path = '/tmp/x' }, TypeError)
})

// --- the write probe, against a real filesystem (the case that only shows up on Windows) ------
// probeWritableDir must not create <root>/data: windows-checklist.ps1 item 2 fails if the
// read-only launch leaves a data folder behind, and a mkdir probe would do exactly that.
function tmpFixture () {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'smartssh-probe-'))
}

// `chmod` denies writes only where the filesystem honours POSIX permission bits: root ignores
// them, and on Windows chmod only toggles the read-only attribute (creating a file still
// succeeds). Measure that capability rather than assuming it from process.platform — the two
// probes below then run wherever they can actually prove something, and are reported as SKIP
// (never as a silent pass) where they cannot.
function chmodDeniesWrites () {
    const dir = tmpFixture()
    try {
        fs.chmodSync(dir, 0o500)
        return probeWritableDir(dir) === false
    } catch {
        return false
    } finally {
        try { fs.chmodSync(dir, 0o700) } catch { /* not supported on this filesystem */ }
        try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
}
const chmodCanDeny = chmodDeniesWrites()

t('probeWritableDir: writable dir -> true and leaves no residue', () => {
    const dir = tmpFixture()
    try {
        assert.strictEqual(probeWritableDir(dir), true)
        assert.deepStrictEqual(fs.readdirSync(dir), [], 'probe file was left behind')
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

if (!chmodCanDeny) {
    r.push(['SKIP', 'probeWritableDir: unwritable dir -> false :: chmod cannot deny writes here (root or non-POSIX filesystem)'])
} else {
    t('probeWritableDir: unwritable dir -> false, creates nothing (no data dir)', () => {
        const dir = tmpFixture()
        try {
            fs.chmodSync(dir, 0o500)
            assert.strictEqual(probeWritableDir(dir), false)
            assert.ok(!fs.existsSync(path.join(dir, 'data')), 'probe must not create <root>/data')
            assert.deepStrictEqual(fs.readdirSync(dir), [], 'probe left something behind')
        } finally {
            fs.chmodSync(dir, 0o700)
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    t('probeWritableDir + resolver: read-only root => scratch path, root stays clean', () => {
        const dir = tmpFixture()
        const scratch = tmpFixture()
        try {
            fs.chmodSync(dir, 0o500)
            const out = resolveUserDataPath({
                portableDir: dir,
                isWritable: probeWritableDir(dir),
                platform: 'linux',
                fallbackUserData: POSIX_FALLBACK,
                tmpDir: scratch,
            })
            assert.strictEqual(out.path, path.posix.join(scratch, 'smartssh-ro'))
            assert.strictEqual(out.readOnlyMode, true)
            assert.deepStrictEqual(fs.readdirSync(dir), [], 'read-only root was written to')
        } finally {
            fs.chmodSync(dir, 0o700)
            fs.rmSync(dir, { recursive: true, force: true })
            fs.rmSync(scratch, { recursive: true, force: true })
        }
    })
}

for (const [status, name] of r) {
    console.log(`${status}  ${name}`)
}
const failed = r.filter(x => x[0] === 'FAIL')
const skipped = r.filter(x => x[0] === 'SKIP')
console.log(`\n${r.length - failed.length - skipped.length}/${r.length - skipped.length} passed${skipped.length ? `, ${skipped.length} skipped` : ''}`)
if (failed.length) {
    process.exit(1)
}
