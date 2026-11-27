// smartssh/verify/windows-path.test.mjs — every path this product writes must use the separator of
// the platform it is running on.
//
// Why this file exists: the Windows job `Core tests` fails while the same commit is green on Linux,
// and no job log is readable without credentials. A path built by string concatenation (or by
// borrowing `path.posix` on win32) is exactly the class of defect that only shows up there, so the
// separator contract is asserted here instead of being discovered on a runner.
//
// The resolvers take the platform as an argument precisely so this can be proven on any host:
//   resolveMetricsPath() / metricsBaseDir()   <- smartssh/app/metricsPath.mjs
//   resolveUserDataPath() / portableDataDir() <- smartssh/app/portablePath.mjs
//
// Run: node smartssh/verify/windows-path.test.mjs
import assert from 'node:assert/strict'

import { metricsBaseDir, resolveMetricsPath } from '../app/metricsPath.mjs'
import { normalizePortableDir, portableDataDir, resolveUserDataPath } from '../app/portablePath.mjs'

const r = []
const t = (name, fn) => { try { fn(); r.push(['PASS', name]) } catch (e) { r.push(['FAIL', name + ' :: ' + e.message]) } }

const WIN_EXE = 'C:\\Apps\\SmartSSH\\smartssh.exe'
const LINUX_EXE = '/opt/smartssh/smartssh.exe'

/** win32 paths: backslash only, and never a '/' prefix (a mixed path is a drive-relative path). */
function assertWinPath (value, what) {
    assert.equal(typeof value, 'string', `${what}: not a string`)
    assert.ok(!value.includes('/'), `${what}: mixed separators in ${value}`)
    assert.ok(!value.startsWith('/'), `${what}: '/' prefix on a win32 path: ${value}`)
}

/** posix paths: forward slash only. */
function assertPosixPath (value, what) {
    assert.equal(typeof value, 'string', `${what}: not a string`)
    assert.ok(!value.includes('\\'), `${what}: backslash in a posix path: ${value}`)
    assert.ok(value.startsWith('/'), `${what}: posix path is not absolute: ${value}`)
}

// --------------------------------------------------------------- metrics path (default branch)

t('resolveMetricsPath win32: <exe dir>\\data\\metrics.json, backslashes only', () => {
    const out = resolveMetricsPath({}, WIN_EXE, 'win32')
    assert.equal(out, 'C:\\Apps\\SmartSSH\\data\\metrics.json')
    assertWinPath(out, 'win32 default metrics path')
})

t('resolveMetricsPath linux: <exe dir>/data/metrics.json, forward slashes only', () => {
    const out = resolveMetricsPath({}, LINUX_EXE, 'linux')
    assert.equal(out, '/opt/smartssh/data/metrics.json')
    assertPosixPath(out, 'linux default metrics path')
})

t('resolveMetricsPath win32 honours PORTABLE_EXECUTABLE_DIR and normalises forward slashes', () => {
    const out = resolveMetricsPath(
        { PORTABLE_EXECUTABLE_DIR: 'D:/Portable/SmartSSH/' },
        'C:\\Users\\me\\AppData\\Local\\Temp\\smartssh-portable.exe',
        'win32')
    assert.equal(out, 'D:\\Portable\\SmartSSH\\data\\metrics.json')
    assertWinPath(out, 'win32 portable metrics path')
})

t('resolveMetricsPath win32: a relative override is joined onto the base with backslashes', () => {
    const out = resolveMetricsPath({ SMARTSSH_MEASURE_PATH: 'out/metrics.json' }, WIN_EXE, 'win32')
    assert.equal(out, 'C:\\Apps\\SmartSSH\\out\\metrics.json')
    assertWinPath(out, 'win32 relative override')
})

t('resolveMetricsPath win32: a posix-looking absolute override never leaks a "/" into the result', () => {
    const out = resolveMetricsPath({ SMARTSSH_MEASURE_PATH: '/var/tmp/metrics.json' }, WIN_EXE, 'win32')
    assertWinPath(out, 'win32 absolute override')
    assert.ok(out.endsWith('metrics.json'), out)
})

t('metricsBaseDir follows the same rule on both platforms', () => {
    assert.equal(metricsBaseDir({}, WIN_EXE, 'win32'), 'C:\\Apps\\SmartSSH')
    assertWinPath(metricsBaseDir({}, WIN_EXE, 'win32'), 'win32 base dir')
    assert.equal(metricsBaseDir({}, LINUX_EXE, 'linux'), '/opt/smartssh')
    assertPosixPath(metricsBaseDir({}, LINUX_EXE, 'linux'), 'linux base dir')
})

// --------------------------------------------------------------- userData path (portable branch)

t('resolveUserDataPath win32 writable: <portable>\\data, no mixed separators', () => {
    const out = resolveUserDataPath({
        portableDir: 'D:/Apps/SmartSSH/',
        isWritable: true,
        platform: 'win32',
        fallbackUserData: 'C:\\Users\\me\\AppData\\Roaming\\SmartSSH',
    })
    assert.equal(out.path, 'D:\\Apps\\SmartSSH\\data')
    assertWinPath(out.path, 'win32 userData path')
})

t('resolveUserDataPath win32 read-only: tmp\\smartssh-ro, still backslashes only', () => {
    const out = resolveUserDataPath({
        portableDir: 'E:\\ro\\SmartSSH',
        isWritable: false,
        platform: 'win32',
        fallbackUserData: 'C:\\Users\\me\\AppData\\Roaming\\SmartSSH',
        tmpDir: 'C:\\SmartSSHTemp',
    })
    assert.equal(out.path, 'C:\\SmartSSHTemp\\smartssh-ro')
    assertWinPath(out.path, 'win32 read-only path')
})

t('resolveUserDataPath linux writable: <portable>/data, forward slashes only', () => {
    const out = resolveUserDataPath({
        portableDir: '/opt/smartssh',
        isWritable: true,
        platform: 'linux',
        fallbackUserData: '/home/me/.config/SmartSSH',
    })
    assert.equal(out.path, '/opt/smartssh/data')
    assertPosixPath(out.path, 'linux userData path')
})

t('a posix-shaped portable dir on win32 still yields a backslash path, not a "/" prefix', () => {
    const out = resolveUserDataPath({
        portableDir: '/opt/smartssh',
        isWritable: true,
        platform: 'win32',
        fallbackUserData: 'C:\\Users\\me\\AppData\\Roaming\\SmartSSH',
    })
    assert.equal(out.path, '\\opt\\smartssh\\data')
    assertWinPath(out.path, 'win32 path from a posix-shaped input')
})

t('portableDataDir agrees with the resolver separator on both platforms', () => {
    const win = portableDataDir('D:/Apps/SmartSSH/', 'win32')
    assert.equal(win, 'D:\\Apps\\SmartSSH\\data')
    assertWinPath(win, 'win32 portableDataDir')

    const posix = portableDataDir('/opt/smartssh/', 'linux')
    assert.equal(posix, '/opt/smartssh/data')
    assertPosixPath(posix, 'linux portableDataDir')
})

t('UNC portable dir stays UNC and gets a backslash child on win32', () => {
    const out = resolveUserDataPath({
        portableDir: '\\\\fileserver\\share\\SmartSSH\\',
        isWritable: true,
        platform: 'win32',
        fallbackUserData: 'C:\\Users\\me\\AppData\\Roaming\\SmartSSH',
    })
    assert.equal(out.path, '\\\\fileserver\\share\\SmartSSH\\data')
    assertWinPath(out.path, 'win32 UNC path')
    assert.equal(normalizePortableDir('\\\\fileserver\\share\\SmartSSH\\', 'win32'), '\\\\fileserver\\share\\SmartSSH')
})

for (const [status, name] of r) console.log(`${status}  ${name}`)
const failed = r.filter((x) => x[0] === 'FAIL')
console.log(`\n${r.length - failed.length}/${r.length} passed`)
process.exit(failed.length ? 1 : 0)
