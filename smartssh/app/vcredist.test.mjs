// smartssh/app/vcredist.test.mjs — the runtime preflight must name the runtime, or it is noise.
//
// The defect this guards against: on a clean Windows image the shipped exe drew its splash and then
// never drew a window, because `russh.win32-x64-msvc.node` failed to load (Windows error 126). No
// message, no exit code, no clue. The preflight therefore has exactly four obligations:
//   1. it looks in the places a runtime actually lives (next to the exe first, then System32);
//   2. it reports *every* missing DLL with the directories it searched;
//   3. the message a human reads names the runtime and carries the download URL (verbatim, in the
//      same words the acceptance checklist uses);
//   4. it refuses with the same exit code everywhere (3), and never blocks on a non-Windows host.
// Run: node smartssh/app/vcredist.test.mjs
import assert from 'node:assert/strict'

import {
    checkRuntime,
    findRedistInstaller,
    findRuntimeDlls,
    isWindowsPlatform,
    runtimeDirs,
    runtimeMessage,
    EXIT_CODE_MISSING_RUNTIME,
    REDIST_DOCS_URL,
    REDIST_INSTALLER_NAME,
    REDIST_URL,
    RUNTIME_DLLS,
    RUNTIME_TITLE_EN,
    RUNTIME_TITLE_ZH,
} from './vcredist.mjs'

const r = []
const t = (name, fn) => {
    try { fn(); r.push(['PASS', name]) } catch (e) { r.push(['FAIL', name + ' :: ' + e.message]) }
}

/** exists() backed by a plain set of paths: no filesystem, no runtime, no Windows. */
function fakeFs (paths) {
    const normalised = new Set(paths.map((p) => p.toLowerCase()))
    return (p) => normalised.has(p.toLowerCase())
}

// ---------------------------------------------------------------- constants the other side pins

t('exit code is 3 and the two DLLs are the ones the addon needs', () => {
    assert.equal(EXIT_CODE_MISSING_RUNTIME, 3)
    assert.deepEqual([...RUNTIME_DLLS], ['vcruntime140.dll', 'msvcp140.dll'])
    assert.equal(REDIST_INSTALLER_NAME, 'vc_redist.x64.exe')
    assert.match(REDIST_URL, /^https:\/\/aka\.ms\/vs\/17\/release\/vc_redist\.x64\.exe$/)
    assert.match(REDIST_DOCS_URL, /^https:\/\/learn\.microsoft\.com\//)
})

// ---------------------------------------------------------------- where it looks

t('win32 dirs: portable dir, then exe dir, then System32, backslashes only', () => {
    const dirs = runtimeDirs({
        platform: 'win32',
        systemRoot: 'C:\\Windows',
        exeDir: 'C:\\Users\\me\\AppData\\Local\\Temp\\2Xyz\\resources',
        portableDir: 'D:\\Portable\\SmartSSH',
    })
    assert.deepEqual(dirs, [
        'D:\\Portable\\SmartSSH',
        'C:\\Users\\me\\AppData\\Local\\Temp\\2Xyz\\resources',
        'C:\\Windows\\System32',
    ])
    for (const dir of dirs) assert.ok(!dir.includes('/'), `mixed separators in ${dir}`)
})

t('win32 dirs: duplicates collapse case-insensitively, empty values are dropped', () => {
    const dirs = runtimeDirs({
        platform: 'win32',
        systemRoot: 'C:\\Windows',
        exeDir: 'd:\\portable\\smartssh\\',
        portableDir: 'D:\\Portable\\SmartSSH',
    })
    assert.deepEqual(dirs, ['D:\\Portable\\SmartSSH', 'C:\\Windows\\System32'])
})

t('linux dirs are posix and never gain a backslash', () => {
    const dirs = runtimeDirs({ platform: 'linux', exeDir: '/opt/smartssh', portableDir: '/opt/smartssh/' })
    assert.deepEqual(dirs, ['/opt/smartssh'])
})

t('isWindowsPlatform only accepts win32', () => {
    assert.equal(isWindowsPlatform('win32'), true)
    assert.equal(isWindowsPlatform('linux'), false)
    assert.equal(isWindowsPlatform('darwin'), false)
})

// ---------------------------------------------------------------- the verdict

t('both DLLs present anywhere => ok, and the reporting dir is the one that matched', () => {
    const dirs = ['C:\\Apps\\SmartSSH', 'C:\\Windows\\System32']
    const exists = fakeFs(['C:\\Apps\\SmartSSH\\vcruntime140.dll', 'C:\\Windows\\System32\\msvcp140.dll'])
    const result = findRuntimeDlls({ dirs, exists })
    assert.equal(result.ok, true)
    assert.deepEqual(result.missing, [])
    assert.deepEqual(result.found, [
        { dll: 'vcruntime140.dll', dir: 'C:\\Apps\\SmartSSH' },
        { dll: 'msvcp140.dll', dir: 'C:\\Windows\\System32' },
    ])
})

t('one DLL missing is still a failure (a half runtime cannot load the addon)', () => {
    const dirs = ['C:\\Windows\\System32']
    const result = findRuntimeDlls({ dirs, exists: fakeFs(['C:\\Windows\\System32\\vcruntime140.dll']) })
    assert.equal(result.ok, false)
    assert.deepEqual(result.missing.map((m) => m.dll), ['msvcp140.dll'])
    assert.deepEqual(result.missing[0].searched, ['C:\\Windows\\System32'])
})

t('no directories at all => everything missing, nothing invented as found', () => {
    const result = findRuntimeDlls({ dirs: [], exists: () => true })
    assert.equal(result.ok, false)
    assert.equal(result.found.length, 0)
    assert.deepEqual(result.missing.map((m) => m.dll), [...RUNTIME_DLLS])
})

t('an exists() that throws counts as "not found", never as a pass', () => {
    const result = findRuntimeDlls({
        dirs: ['C:\\Windows\\System32'],
        exists: () => { throw new Error('EACCES') },
    })
    assert.equal(result.ok, false)
})

// ---------------------------------------------------------------- the message

t('message names the runtime in the operator-agreed words, with the download URL', () => {
    const result = findRuntimeDlls({ dirs: ['C:\\Windows\\System32'], exists: () => false })
    const message = runtimeMessage(result)
    assert.ok(message.includes(RUNTIME_TITLE_ZH), 'missing zh title')
    assert.ok(message.includes(RUNTIME_TITLE_EN), 'missing en title')
    assert.ok(message.includes(REDIST_URL), 'missing download URL')
    assert.ok(message.includes(REDIST_DOCS_URL), 'missing docs URL')
    // The phrase the acceptance card demands verbatim.
    assert.ok(message.includes('需要 Microsoft Visual C++ 2015–2022 x64 Redistributable'))
    // A support engineer must not need a debugger to match this to the observed crash.
    assert.ok(message.includes('126'), 'missing the Windows error code')
    assert.ok(message.includes('russh.win32-x64-msvc.node'), 'missing the failing module')
    // Which DLL is missing and where we looked.
    assert.ok(message.includes('vcruntime140.dll'))
    assert.ok(message.includes('msvcp140.dll'))
    assert.ok(message.includes('C:\\Windows\\System32'))
})

t('message is bilingual: neither locale can be left with only the other language', () => {
    const message = runtimeMessage(findRuntimeDlls({ dirs: [], exists: () => false }))
    assert.ok(/[\u4e00-\u9fff]/.test(message), 'no Chinese text')
    assert.ok(/(why|fix|missing|download)/.test(message), 'no English text')
})

// ---------------------------------------------------------------- host applicability

t('non-Windows hosts are a no-op: applicable=false, ok=true, no message', () => {
    for (const platform of ['linux', 'darwin']) {
        const result = checkRuntime({ platform })
        assert.equal(result.applicable, false, platform)
        assert.equal(result.ok, true, platform)
        assert.equal(result.message, '', platform)
    }
})

t('win32 without an exists() probe is a programming error, not a silent pass', () => {
    assert.throws(() => checkRuntime({ platform: 'win32', systemRoot: 'C:\\Windows' }), /exists/)
})

t('checkRuntime win32: clean image fails with the exit code the checklist returns', () => {
    const result = checkRuntime({
        platform: 'win32',
        systemRoot: 'C:\\Windows',
        exeDir: 'C:\\Apps\\SmartSSH',
        exists: fakeFs([]),
    })
    assert.equal(result.applicable, true)
    assert.equal(result.ok, false)
    assert.deepEqual(result.dirs, ['C:\\Apps\\SmartSSH', 'C:\\Windows\\System32'])
    assert.ok(result.message.includes(RUNTIME_TITLE_ZH))
})

t('checkRuntime win32: app-local DLLs next to the exe are enough', () => {
    const result = checkRuntime({
        platform: 'win32',
        systemRoot: 'C:\\Windows',
        exeDir: 'C:\\Apps\\SmartSSH',
        exists: fakeFs(['C:\\Apps\\SmartSSH\\vcruntime140.dll', 'C:\\Apps\\SmartSSH\\msvcp140.dll']),
    })
    assert.equal(result.ok, true)
    assert.equal(result.message, '')
})

// ---------------------------------------------------------------- offline drop-in installer

t('a vc_redist.x64.exe next to the exe is offered, and nothing is downloaded by us', () => {
    const dirs = ['C:\\Apps\\SmartSSH', 'C:\\Windows\\System32']
    const hit = findRedistInstaller({ dirs, exists: fakeFs(['C:\\Apps\\SmartSSH\\vc_redist.x64.exe']) })
    assert.deepEqual(hit, { path: 'C:\\Apps\\SmartSSH\\vc_redist.x64.exe', dir: 'C:\\Apps\\SmartSSH' })
    assert.equal(findRedistInstaller({ dirs, exists: fakeFs([]) }), null)
})

// ---------------------------------------------------------------- report

for (const [status, name] of r) console.log(`${status}  ${name}`)
const fails = r.filter(([status]) => status === 'FAIL').length
console.log(`${r.length - fails}/${r.length} passed`)
process.exit(fails ? 1 : 0)
