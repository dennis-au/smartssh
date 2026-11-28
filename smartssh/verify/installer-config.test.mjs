// smartssh/verify/installer-config.test.mjs — the NSIS installer must stay an *assisted* setup.exe:
// a wizard, a user-chosen install directory, Start Menu + desktop shortcuts and a Control Panel
// uninstall entry — and it must actually be wired into the build, not just declared in a yml file.
//
// Why a test and not a review note: every one of these settings is a single word away from the
// failure this card exists to prevent. `oneClick: true` turns the wizard into a silent install,
// `allowToChangeInstallationDirectory: false` takes the directory choice away, and
// `shortcutName: Tabby Terminal` ships the upstream brand on the user's desktop. A yml block that
// nobody checks is decoration, so this file reads the real `electron-builder.yml`, the real build
// script and the real workflow, and asserts the three of them agree.
//
// Every assertion is proven able to fail: the parsed documents are mutated once per rule below and
// the validator must name that rule. A check that cannot fail proves nothing.
//
// Run: node smartssh/verify/installer-config.test.mjs
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const YML_PATH = path.join(REPO_ROOT, 'electron-builder.yml')
const INSTALLER_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-smartssh-installer.mjs')
const PORTABLE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-smartssh.mjs')
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'smartssh-win.yml')

/** The one identity both Windows targets must carry (lockstep with scripts/build-smartssh.mjs). */
const PRODUCT_NAME = 'Smart SSH'
const APP_ID = 'com.smartssh.app'
const SHORTCUT_NAME = 'Smart SSH'

const r = []
const t = (name, fn) => {
    try {
        fn()
        r.push(['PASS', name])
    } catch (e) {
        r.push(['FAIL', `${name} :: ${e.message}`])
    }
}

// ---------------------------------------------------------------------------------------------
// js-yaml: already a dependency of app/ (4.1.0), which CI installs before this test runs. Resolve it
// the way the shipped code would and fail loudly rather than skip — a skipped config test is the
// exact bug this file prevents.
// ---------------------------------------------------------------------------------------------
function loadYamlLibrary () {
    const tried = []
    for (const from of [path.join(REPO_ROOT, 'app', 'package.json'), path.join(REPO_ROOT, 'package.json'), fileURLToPath(import.meta.url)]) {
        try {
            return createRequire(from)('js-yaml')
        } catch (e) {
            tried.push(`${from}: ${e.code || e.message}`)
        }
    }
    throw new Error(`js-yaml is not resolvable — run \`(cd app && yarn) && yarn\` first\n  ${tried.join('\n  ')}`)
}

let yaml
try {
    yaml = loadYamlLibrary()
} catch (e) {
    process.stdout.write(`FAIL cannot load js-yaml :: ${e.message}\n0/0 passed\n`)
    process.exit(2)
}

const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v])

// ---------------------------------------------------------------------------------------------
// 1. electron-builder.yml — the installer contract itself.
// ---------------------------------------------------------------------------------------------
function validateBuilderYml (doc) {
    const problems = []
    const add = (m) => problems.push(m)

    const nsis = doc?.nsis
    if (!nsis || typeof nsis !== 'object' || Array.isArray(nsis)) {
        add('electron-builder.yml has no `nsis:` mapping — there is no installer configuration at all')
        return problems
    }

    // The block is only read by electron-builder when the nsis target is actually selected.
    const targets = asList(doc?.win?.target).map((entry) => (typeof entry === 'string' ? entry : entry?.target))
    if (!targets.includes('nsis')) {
        add(`win.target does not list 'nsis' (got ${JSON.stringify(doc?.win?.target)}) — electron-builder never builds an installer`)
    }

    // Strict booleans on purpose: the string "false" is truthy in a JS consumer, and a missing key
    // is not the same statement as an explicit `false`.
    if (nsis.oneClick !== false) {
        add(`nsis.oneClick must be the boolean false, got ${JSON.stringify(nsis.oneClick)} — anything else makes this a one-click/silent install`)
    }
    if (nsis.allowToChangeInstallationDirectory !== true) {
        add(`nsis.allowToChangeInstallationDirectory must be true, got ${JSON.stringify(nsis.allowToChangeInstallationDirectory)} — the user has to be able to pick the install directory`)
    }
    if (nsis.shortcutName !== SHORTCUT_NAME) {
        add(`nsis.shortcutName must be ${JSON.stringify(SHORTCUT_NAME)}, got ${JSON.stringify(nsis.shortcutName)} — this names the Start Menu entry, the desktop shortcut and the uninstall entry`)
    }
    if (nsis.createStartMenuShortcut !== true) {
        add(`nsis.createStartMenuShortcut must be true, got ${JSON.stringify(nsis.createStartMenuShortcut)}`)
    }
    if (nsis.createDesktopShortcut !== true) {
        add(`nsis.createDesktopShortcut must be true, got ${JSON.stringify(nsis.createDesktopShortcut)}`)
    }
    if (nsis.perMachine === true) {
        add('nsis.perMachine must not be true — installing a terminal must not demand admin elevation')
    }
    if (nsis.deleteAppDataOnUninstall !== true) {
        add(`nsis.deleteAppDataOnUninstall must be true, got ${JSON.stringify(nsis.deleteAppDataOnUninstall)} — "uninstall leaves nothing behind" is part of the acceptance contract`)
    }

    const artifactName = String(nsis.artifactName ?? '')
    if (!artifactName.includes('smartssh')) {
        add(`nsis.artifactName must carry the smartssh identity, got ${JSON.stringify(artifactName)} — the setup.exe would land under the upstream brand`)
    }
    if (!artifactName.includes('${version}')) {
        add(`nsis.artifactName must carry \${version}, got ${JSON.stringify(artifactName)} — the installer name would not identify the release`)
    }

    // The portable build is the thing that must not regress: its artifact name has to keep the
    // `portable` marker, or a verifier cannot tell the two exes apart by name.
    const winArtifact = String(doc?.win?.artifactName ?? '')
    if (!winArtifact.includes('portable')) {
        add(`win.artifactName must keep the 'portable' marker, got ${JSON.stringify(winArtifact)} — the portable exe and the installer would become indistinguishable`)
    }

    return problems
}

// ---------------------------------------------------------------------------------------------
// 2. The build script — the yml above is inert unless a script selects the nsis target.
// ---------------------------------------------------------------------------------------------
/** Drop full-line `//` comments so prose about `portable` is not mistaken for a target. */
const codeOnly = (text) => text.split(/\r?\n/).filter((l) => !l.trimStart().startsWith('//')).join('\n')

function validateInstallerScript (text) {
    const problems = []
    const add = (m) => problems.push(m)
    const code = codeOnly(text)

    if (!/win:\s*\[\s*['"]nsis['"]\s*\]/.test(code)) {
        add("scripts/build-smartssh-installer.mjs never selects win: ['nsis'] — nothing builds an installer")
    }
    if (!/target:\s*['"]nsis['"]/.test(code)) {
        add("scripts/build-smartssh-installer.mjs does not declare a { target: 'nsis' } entry")
    }
    if (/['"]portable['"]/.test(code)) {
        add('scripts/build-smartssh-installer.mjs also selects the portable target — the two builds must stay separate scripts')
    }
    if (/oneClick/.test(code)) {
        add('scripts/build-smartssh-installer.mjs sets oneClick — the assisted-install promise belongs to electron-builder.yml alone, so a script-level flip is invisible to review')
    }
    if (!new RegExp(`productName:\\s*['"]${PRODUCT_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(code)) {
        add(`scripts/build-smartssh-installer.mjs does not set productName ${JSON.stringify(PRODUCT_NAME)} — the installed app and the portable exe would carry different names`)
    }
    if (!new RegExp(`appId:\\s*['"]${APP_ID.replace(/\./g, '\\.')}['"]`).test(code)) {
        add(`scripts/build-smartssh-installer.mjs does not set appId ${JSON.stringify(APP_ID)}`)
    }
    return problems
}

function validatePortableScript (text) {
    const problems = []
    const code = codeOnly(text)
    if (!/win:\s*\[\s*['"]portable['"]\s*\]/.test(code)) {
        problems.push("scripts/build-smartssh.mjs no longer selects win: ['portable'] — the portable build regressed")
    }
    if (/['"]nsis['"]/.test(code)) {
        problems.push('scripts/build-smartssh.mjs also selects nsis — the portable build must not start shipping an installer')
    }
    if (!new RegExp(`productName:\\s*['"]${PRODUCT_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(code)) {
        problems.push(`scripts/build-smartssh.mjs no longer sets productName ${JSON.stringify(PRODUCT_NAME)} — the two targets drifted apart`)
    }
    return problems
}

// ---------------------------------------------------------------------------------------------
// 3. The workflow — both exes must be produced, hashed and published, or the contract in
//    ci-status/<run>.json can never be satisfied.
// ---------------------------------------------------------------------------------------------
function workflowSteps (doc) {
    const steps = doc?.jobs?.portable?.steps
    if (!Array.isArray(steps)) throw new Error('jobs.portable.steps is missing — there is no job to check')
    return steps
}

const runOf = (step) => String(step?.run ?? '')

function validateWorkflow (doc) {
    const problems = []
    const add = (m) => problems.push(m)
    let steps
    try {
        steps = workflowSteps(doc)
    } catch (e) {
        return [e.message]
    }

    const portableStep = steps.find((s) => s?.id === 'portable')
    const setupStep = steps.filter((s) => /build-smartssh-installer\.mjs/.test(runOf(s)))

    if (!portableStep) add("no step with id 'portable' — the portable build disappeared from the job")
    if (setupStep.length !== 1) {
        add(`expected exactly one step running scripts/build-smartssh-installer.mjs, found ${setupStep.length}`)
    } else {
        const step = setupStep[0]
        if (String(step.if ?? '') === '' || String(step.if ?? '').trim() === '') {
            add('the installer step has no `if:` — a branch push would build an installer too')
        } else if (portableStep && String(step.if) !== String(portableStep.if)) {
            add(`the installer step is gated differently from the portable step (${JSON.stringify(String(step.if))} vs ${JSON.stringify(String(portableStep.if ?? ''))}) — both exes must ship together or not at all`)
        }
        if (!/build-smartssh-installer\.mjs/.test(runOf(step))) add('the installer step does not run build-smartssh-installer.mjs')
        // A build script that produced nothing must fail the step, not fall through to the status file.
        if (!/Get-ChildItem[^\n]*\*setup\*\.exe/.test(runOf(step)) || !/throw/.test(runOf(step))) {
            add('the installer step does not verify that dist/*setup*.exe exists after the build')
        }
    }

    const hash = steps.find((s) => s?.id === 'hash')
    if (!hash) {
        add("no step with id 'hash' — nothing produces the artifact hashes")
    } else {
        if (!/\*portable\*\.exe/.test(runOf(hash))) add('the hash step does not hash dist/*portable*.exe')
        if (!/\*setup\*\.exe/.test(runOf(hash))) add('the hash step does not hash dist/*setup*.exe — artifacts.setup would be empty')
        if (!/\bthrow\b/.test(runOf(hash))) add('the hash step does not fail when an expected exe is missing — an empty artifact would be published as success')
        if (!/artifact-sha256\.json/.test(runOf(hash))) add('the hash step does not write artifact-sha256.json — the status step has nothing machine-readable to publish')
    }

    const status = steps.find((s) => /^Publish status/i.test(String(s?.name ?? '')))
    if (!status) {
        add('no "Publish status" step — the credential-free read channel is gone')
    } else {
        const body = runOf(status)
        if (!/'artifacts'/.test(body)) add("the status step never sets out['artifacts'] — ci-status/<run>.json would lack the {portable, setup} object")
        if (!/artifact-sha256\.json/.test(body)) add('the status step does not read artifact-sha256.json')
        for (const kind of ['portable', 'setup']) {
            if (!new RegExp(`(^|\\s)${kind}(\\s|$)`, 'm').test(body) && !new RegExp(`'${kind}'`).test(body)) {
                add(`the status step does not mention the ${kind} artifact`)
            }
        }
        if (!/S_SETUP/.test(body) || !/setup\s*=/.test(body) && !/setup\s+=/.test(body)) {
            add('the status step does not publish the setup step outcome')
        }
    }

    const upload = steps.find((s) => /upload-artifact/.test(String(s?.uses ?? '')))
    if (!upload) {
        add('no upload-artifact step — the exes would exist only on the runner')
    } else {
        const paths = String(upload?.with?.path ?? '')
        if (!/dist\/\*portable\*\.exe/.test(paths)) add('the artifact upload no longer carries dist/*portable*.exe')
        if (!/dist\/\*setup\*\.exe/.test(paths)) add('the artifact upload does not carry dist/*setup*.exe — the installer would not be downloadable')
    }

    const release = steps.find((s) => s?.name === 'Draft release')
    if (!release) {
        add('no "Draft release" step — a tagged build would produce no published artifact')
    } else {
        const body = runOf(release)
        if (!/\*setup\*\.exe/.test(body)) add('the draft release never looks for dist/*setup*.exe — the installer would not be retrievable without a token')
        if (!/\$setup\.FullName/.test(body)) add('the draft release does not attach the setup exe — only the portable build would be published')
        if (!/\$portable\.FullName/.test(body)) add('the draft release does not attach the portable exe')
    }

    return problems
}

// ---------------------------------------------------------------------------------------------
// 5. The NSIS include itself — a `File` that points at an asset this repo does not ship aborts
//    makensis and no setup.exe exists at all. That is exactly how the first real assembly attempt
//    failed: build/installer.nsh (inherited from upstream Tabby) hard-references
//    build/vc_redist.exe, which is deliberately absent — smartssh must not bundle a Microsoft
//    binary (smartssh/docs/vcredist-decision.md, option A). The include therefore keeps the
//    upstream convenience only when an operator drops the file in, and skips it otherwise.
// ---------------------------------------------------------------------------------------------
const NSH_PATH = path.join(REPO_ROOT, 'build', 'installer.nsh')

/** NSIS comments start at `;` (whole line or after whitespace). Prose about a file is not a reference. */
const nsisCode = (text) => text.split(/\r?\n/).map((l) => l.replace(/(^|\s);.*$/, '$1')).join('\n')

function validateInstallerNsh (text) {
    const problems = []
    const add = (m) => problems.push(m)
    const code = nsisCode(text)
    if (!/!macro\s+customInstall/.test(code)) {
        add('build/installer.nsh has no customInstall macro — electron-builder includes this file for the installer, so its absence means the include was silently dropped')
    }
    // Every `File "...${BUILD_RESOURCES_DIR}\<name>"` must be satisfiable at build time: `File` is a
    // compile-time directive, so makensis resolves it while compiling and a missing asset aborts the
    // whole installer. /nonfatal is NOT an escape hatch — electron-builder compiles with -WX (warnings
    // as errors), so the resulting warning 7010 fails the build too. The asset has to be in the tree.
    const re = /\bFile\s+(?:\/[^\s"]+\s+)*"\$\{BUILD_RESOURCES_DIR\}\\([^"]+)"/g
    let m
    while ((m = re.exec(code)) !== null) {
        const rel = m[1]
        if (fs.existsSync(path.join(REPO_ROOT, 'build', rel))) continue
        add(`build/installer.nsh \`File\` references build/${rel}, which this repo does not ship — makensis aborts the installer build and no setup.exe is produced`)
    }
    return problems
}

// ---------------------------------------------------------------------------------------------
// Read the real files. A missing file is a failure, never a skip.
// ---------------------------------------------------------------------------------------------
function readOrFail (file, problems) {
    try {
        return fs.readFileSync(file, 'utf8')
    } catch (e) {
        problems.push(`cannot read ${path.relative(REPO_ROOT, file)} :: ${e.message}`)
        return ''
    }
}

const filesProblems = []
const ymlText = readOrFail(YML_PATH, filesProblems)
const installerText = readOrFail(INSTALLER_SCRIPT, filesProblems)
const portableText = readOrFail(PORTABLE_SCRIPT, filesProblems)
const workflowText = readOrFail(WORKFLOW_PATH, filesProblems)
const nshText = readOrFail(NSH_PATH, filesProblems)
for (const p of filesProblems) process.stdout.write(`FAIL ${p}\n`)
if (filesProblems.length > 0) {
    process.stdout.write(`0/0 passed\n`)
    process.exit(1)
}

let builderDoc = null
let workflowDoc = null

t('electron-builder.yml parses', () => {
    builderDoc = yaml.load(ymlText)
    if (!builderDoc || typeof builderDoc !== 'object') throw new Error('parsed to a non-object')
})

t('nsis target is an assisted installer, not a silent one (zero problems)', () => {
    const problems = validateBuilderYml(builderDoc)
    if (problems.length > 0) throw new Error(`${problems.length} problem(s):\n      - ${problems.join('\n      - ')}`)
})

t('installer build script selects the nsis target and shares the SmartSSH identity', () => {
    const problems = validateInstallerScript(installerText)
    if (problems.length > 0) throw new Error(`${problems.length} problem(s):\n      - ${problems.join('\n      - ')}`)
})

t('portable build script still selects only the portable target (no regression)', () => {
    const problems = validatePortableScript(portableText)
    if (problems.length > 0) throw new Error(`${problems.length} problem(s):\n      - ${problems.join('\n      - ')}`)
})

t('the workflow builds, hashes, uploads and publishes both exes', () => {
    workflowDoc = yaml.load(workflowText)
    if (!workflowDoc || typeof workflowDoc !== 'object') throw new Error('workflow parsed to a non-object')
    const problems = validateWorkflow(workflowDoc)
    if (problems.length > 0) throw new Error(`${problems.length} problem(s):\n      - ${problems.join('\n      - ')}`)
})

t('the NSIS include never points at an asset this repo does not ship', () => {
    const problems = validateInstallerNsh(nshText)
    if (problems.length > 0) throw new Error(`${problems.length} problem(s):\n      - ${problems.join('\n      - ')}`)
})

t('mutation rejected: the bundle-a-redist File directive comes back', () => {
    const mutated = nshText.replace('!macroend', '  File /nonfatal "${BUILD_RESOURCES_DIR}\\vc_redist.exe"\n!macroend')
    const problems = validateInstallerNsh(mutated)
    if (problems.length === 0) throw new Error('still validates — this assertion cannot fail')
    if (!problems.some((p) => /vc_redist\.exe/.test(p))) throw new Error(`expected a problem naming vc_redist.exe, got:\n      - ${problems.join('\n      - ')}`)
})

t('the redist stays operator-supplied: no download, no bundled binary', () => {
    // The installer may run a redist the operator placed beside it, and must never fetch or carry one.
    const code = nsisCode(nshText)
    if (/\bFile\b[^\n]*BUILD_RESOURCES_DIR/.test(code)) throw new Error('build/installer.nsh packages a build/ asset again')
    if (/https?:\/\//.test(code)) throw new Error('build/installer.nsh references a URL — the installer must never download a binary')
    if (!/\$EXEDIR\\vc_redist\.x64\.exe/.test(code)) throw new Error('the operator-supplied redist path ($EXEDIR\\vc_redist.x64.exe) is no longer offered')
})

t('mutation rejected: a new unguarded File directive creeps in', () => {
    const mutated = nshText.replace('!macroend', '  File "${BUILD_RESOURCES_DIR}\\nope.dll"\n!macroend')
    const problems = validateInstallerNsh(mutated)
    if (problems.length === 0) throw new Error('still validates — this assertion cannot fail')
    if (!problems.some((p) => /nope\.dll/.test(p))) throw new Error(`expected a problem naming nope.dll, got:\n      - ${problems.join('\n      - ')}`)
})

// ---------------------------------------------------------------------------------------------
// 4. Every rule must be able to fail. One mutation per rule; the validator must name that rule.
// ---------------------------------------------------------------------------------------------
const clone = (v) => structuredClone(v)
const stepById = (doc, id) => workflowSteps(doc).find((s) => s?.id === id)
const stepByRun = (doc, re) => workflowSteps(doc).find((s) => re.test(runOf(s)))

const YML_MUTATIONS = [
    ['nsis block deleted', (d) => { delete d.nsis }, /nsis: mapping|nsis:/],
    ['oneClick turned into a silent install', (d) => { d.nsis.oneClick = true }, /oneClick/],
    ['oneClick written as the string "false"', (d) => { d.nsis.oneClick = 'false' }, /oneClick/],
    ['oneClick key removed', (d) => { delete d.nsis.oneClick }, /oneClick/],
    ['install directory locked', (d) => { d.nsis.allowToChangeInstallationDirectory = false }, /allowToChangeInstallationDirectory/],
    ['shortcutName back to the upstream brand', (d) => { d.nsis.shortcutName = 'Tabby Terminal' }, /shortcutName/],
    ['start menu shortcut dropped', (d) => { d.nsis.createStartMenuShortcut = false }, /createStartMenuShortcut/],
    ['desktop shortcut dropped', (d) => { d.nsis.createDesktopShortcut = false }, /createDesktopShortcut/],
    ['installer demands admin elevation', (d) => { d.nsis.perMachine = true }, /perMachine/],
    ['uninstall keeps the user data', (d) => { d.nsis.deleteAppDataOnUninstall = false }, /deleteAppDataOnUninstall/],
    ['artifactName loses the smartssh identity', (d) => { d.nsis.artifactName = 'tabby-${version}-setup-${env.ARCH}.${ext}' }, /artifactName/],
    ['artifactName loses the version', (d) => { d.nsis.artifactName = 'smartssh-setup.exe' }, /artifactName/],
    ['win.target stops listing nsis', (d) => { d.win.target = [{ target: 'portable', arch: ['x64'] }] }, /win\.target/],
    ['portable marker dropped from the win artifactName', (d) => { d.win.artifactName = 'tabby-${version}-${env.ARCH}.${ext}' }, /portable/],
]

for (const [name, mutate, expected] of YML_MUTATIONS) {
    t(`mutation rejected: ${name}`, () => {
        const d = clone(builderDoc)
        mutate(d)
        const problems = validateBuilderYml(d)
        if (problems.length === 0) throw new Error('still validates — this assertion cannot fail')
        const hit = problems.find((p) => expected.test(p))
        if (!hit) throw new Error(`expected a problem matching ${expected}, got:\n      - ${problems.join('\n      - ')}`)
    })
}

const SCRIPT_MUTATIONS = [
    ['installer script builds the portable target instead', (text) => text.replace(`win: ["nsis"]`, `win: ["portable"]`), /nsis/],
    ['installer script also builds portable', (text) => text.replace(`win: ["nsis"]`, `win: ["nsis", "portable"]`), /portable/],
    ['installer script flips oneClick itself', (text) => text.replace('forceCodeSigning: false,', 'forceCodeSigning: false,\n        oneClick: true,'), /oneClick/],
    ['installer script loses the SmartSSH productName', (text) => text.replace(`productName: "Smart SSH"`, `productName: "Tabby"`), /productName/],
    ['installer script loses the appId', (text) => text.replace(`appId: "com.smartssh.app"`, `appId: "org.tabby"`), /appId/],
]

for (const [name, mutate, expected] of SCRIPT_MUTATIONS) {
    t(`mutation rejected: ${name}`, () => {
        const problems = validateInstallerScript(mutate(installerText))
        if (problems.length === 0) throw new Error('still validates — this assertion cannot fail')
        const hit = problems.find((p) => expected.test(p))
        if (!hit) throw new Error(`expected a problem matching ${expected}, got:\n      - ${problems.join('\n      - ')}`)
    })
}

t('mutation rejected: portable script starts building nsis too', () => {
    const problems = validatePortableScript(portableText.replace(`win: ["portable"]`, `win: ["portable", "nsis"]`))
    if (problems.length === 0) throw new Error('still validates — this assertion cannot fail')
    if (!problems.some((p) => /nsis/.test(p))) throw new Error(`expected a problem naming nsis, got:\n      - ${problems.join('\n      - ')}`)
})

const WORKFLOW_MUTATIONS = [
    ['installer step removed', (d) => { d.jobs.portable.steps = workflowSteps(d).filter((s) => !/build-smartssh-installer\.mjs/.test(runOf(s))) }, /installer step|build-smartssh-installer/],
    ['installer step runs on every ref', (d) => { stepByRun(d, /build-smartssh-installer\.mjs/).if = 'always()' }, /gated differently/],
    ['installer step loses its existence check', (d) => { stepByRun(d, /build-smartssh-installer\.mjs/).run = 'node scripts/build-smartssh-installer.mjs' }, /dist\/\*setup\*\.exe/],
    ['hash step stops hashing the installer', (d) => { const s = stepById(d, 'hash'); s.run = s.run.replace(/\*setup\*\.exe/g, '*setup*.SKIP') }, /setup/],
    ['hash step stops failing on a missing exe', (d) => { const s = stepById(d, 'hash'); s.run = s.run.replace(/\bthrow\b/g, 'Write-Host') }, /does not fail/],
    ['status step stops publishing artifacts', (d) => { const s = workflowSteps(d).find((x) => /^Publish status/i.test(String(x?.name ?? ''))); s.run = s.run.replace(/\$out\['artifacts'\] = \$artifacts/g, '') }, /artifacts/],
    ['artifact upload drops the installer', (d) => { const s = workflowSteps(d).find((x) => /upload-artifact/.test(String(x?.uses ?? ''))); s.with.path = 'dist/*portable*.exe' }, /setup\*\.exe/],
    ['draft release drops the installer', (d) => { const s = workflowSteps(d).find((x) => x?.name === 'Draft release'); s.run = s.run.replace(/ \$setup\.FullName/g, '') }, /setup/],
]

for (const [name, mutate, expected] of WORKFLOW_MUTATIONS) {
    t(`mutation rejected: ${name}`, () => {
        const d = clone(workflowDoc)
        mutate(d)
        const problems = validateWorkflow(d)
        if (problems.length === 0) throw new Error('still validates — this assertion cannot fail')
        const hit = problems.find((p) => expected.test(p))
        if (!hit) throw new Error(`expected a problem matching ${expected}, got:\n      - ${problems.join('\n      - ')}`)
    })
}

// ---------------------------------------------------------------------------------------------
const passed = r.filter(([s]) => s === 'PASS').length
const failed = r.filter(([s]) => s === 'FAIL')
for (const [status, name] of r) process.stdout.write(`${status} ${name}\n`)
if (failed.length > 0) {
    process.stdout.write(`\n${passed}/${r.length} passed, ${failed.length} FAILED\n`)
    process.exitCode = 1
} else {
    process.stdout.write(`\n${passed}/${r.length} passed\n`)
    process.exitCode = 0
}
