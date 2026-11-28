// smartssh/verify/workflow-triggers.test.mjs — the CI gate must fire on a push to `smartssh`, and a
// branch push must be structurally unable to produce an exe or a release.
//
// Why this file exists: three separate "Linux green, Windows red" breaks (a drive letter in
// buildinfoWrite, an encoding bug in the vcredist message, capture timing) were each discovered only
// by spending a whole tag — ~20-30 minutes of runner time per build. The fix is a branch-push
// trigger that runs install / tests / webpack / buildinfo and stops there, so the workflow file now
// carries a promise that is easy to undo by accident: widen one `if:` and a branch push starts
// shipping exes and draft releases.
//
// So this test parses the real workflow with js-yaml (never a regex — a regex cannot tell a real
// trigger from one nested under a different key) and then mutates the parsed document once per
// assertion to prove every assertion can fail. A check that cannot fail is decoration.
//
// Run: node smartssh/verify/workflow-triggers.test.mjs
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'smartssh-win.yml')

/** The four steps a branch push must always run; the cheap half of the gate. */
const GATE_STEP_IDS = ['install', 'tests', 'webpack', 'buildinfo']
/** Steps that build/hash the portable exe: allowed on a tag and on a manual run, never on a push/PR. */
const PACKAGING_STEPS = [
    { id: 'portable', label: 'Portable exe' },
    { id: 'hash', label: 'Hash + version' },
]
/** The draft release is tag-only, full stop: a manual run must not leave a draft behind either. */
const RELEASE_STEPS = [
    { name: 'Draft release', label: 'Draft release' },
]

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
// js-yaml: the repo already depends on it (app/package.json, 4.1.0), and CI installs it before this
// test runs. Resolve it the way the shipped code does, then the way a hoisted install would, and
// fail loudly rather than skip when neither is present — a silently skipped trigger test is exactly
// the bug this file exists to prevent.
// ---------------------------------------------------------------------------------------------
function loadYamlLibrary () {
    const candidates = [
        path.join(REPO_ROOT, 'app', 'package.json'),
        path.join(REPO_ROOT, 'package.json'),
        fileURLToPath(import.meta.url),
    ]
    const tried = []
    for (const from of candidates) {
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

// ---------------------------------------------------------------------------------------------
// Parsing helpers. YAML 1.1 parsers turn a bare `on:` key into boolean true, so the trigger block
// is looked up under every spelling a parser may produce instead of assuming one.
// ---------------------------------------------------------------------------------------------
const TRIGGER_KEYS = ['on', true, 'true', 'True']

function triggersOf (doc) {
    if (!doc || typeof doc !== 'object') return null
    for (const key of TRIGGER_KEYS) {
        if (Object.hasOwn(doc, key)) return { key, value: doc[key] }
    }
    return null
}

function stepsOf (doc) {
    const steps = doc?.jobs?.portable?.steps
    return Array.isArray(steps) ? steps : null
}

function findStep (steps, selector) {
    const hits = steps.filter((s) => s && typeof s === 'object' &&
        ((selector.id !== undefined && s.id === selector.id) || (selector.name !== undefined && s.name === selector.name)))
    if (hits.length === 0) throw new Error(`no step matching ${JSON.stringify(selector)} in jobs.portable.steps`)
    if (hits.length > 1) throw new Error(`${hits.length} steps match ${JSON.stringify(selector)} — cannot tell which one is gated`)
    return hits[0]
}

const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v])

// ---------------------------------------------------------------------------------------------
// A deliberately tiny GitHub-actions `if:` evaluator.
//
// It does not need to understand every expression; it needs to answer one question behaviourally —
// "is this condition true on a tag push and false on every branch push?" — and it throws on any
// syntax it does not know, so a future `if:` cannot slip past by being unparseable.
// ---------------------------------------------------------------------------------------------
const REF_TAG = 'refs/tags/v1.0.247'
const REF_BRANCH = 'refs/heads/smartssh'
const REF_OTHER_BRANCH = 'refs/heads/main'
const REF_PR = 'refs/pull/7/merge'

/** `eventName` defaults to what the ref implies; a manual dispatch runs on a branch ref. */
function refContext (ref, eventName) {
    const isTag = ref.startsWith('refs/tags/')
    const isPull = ref.startsWith('refs/pull/')
    return {
        ref,
        refName: ref.replace(/^refs\/(tags|heads)\//, ''),
        refType: isTag ? 'tag' : 'branch',
        eventName: eventName ?? (isPull ? 'pull_request' : 'push'),
    }
}

function contextValue (ctx, name) {
    switch (name) {
        case 'github.ref': return ctx.ref
        case 'github.ref_name': return ctx.refName
        case 'github.ref_type': return ctx.refType
        case 'github.event_name': return ctx.eventName
        case 'github.event.ref': return ctx.ref
        default: throw new Error(`unknown context value ${name}`)
    }
}

/** Split on a top-level boolean operator, ignoring anything inside quotes or parentheses. */
function splitTopLevel (expr, op) {
    const parts = []
    let depth = 0
    let quote = null
    let last = 0
    for (let i = 0; i < expr.length; i++) {
        const c = expr[i]
        if (quote) {
            if (c === quote) quote = null
            continue
        }
        if (c === "'" || c === '"') { quote = c; continue }
        if (c === '(') depth++
        else if (c === ')') depth--
        else if (depth === 0 && expr.startsWith(op, i)) {
            parts.push(expr.slice(last, i))
            last = i + op.length
            i += op.length - 1
        }
    }
    if (parts.length === 0) return null
    parts.push(expr.slice(last))
    return parts.map((p) => p.trim())
}

function isWrapped (expr) {
    if (!expr.startsWith('(') || !expr.endsWith(')')) return false
    let depth = 0
    for (let i = 0; i < expr.length; i++) {
        if (expr[i] === '(') depth++
        else if (expr[i] === ')') {
            depth--
            if (depth === 0 && i !== expr.length - 1) return false
        }
    }
    return depth === 0
}

function evaluate (rawExpr, ctx) {
    const expr = rawExpr.trim()
    if (expr === '') throw new Error('empty expression')
    const orParts = splitTopLevel(expr, '||')
    if (orParts) return orParts.some((p) => evaluate(p, ctx))
    const andParts = splitTopLevel(expr, '&&')
    if (andParts) return andParts.every((p) => evaluate(p, ctx))
    if (isWrapped(expr)) return evaluate(expr.slice(1, -1), ctx)
    if (expr.startsWith('!')) return !evaluate(expr.slice(1), ctx)
    if (expr === 'always()') return true
    if (expr === 'success()') return true
    if (expr === 'failure()' || expr === 'cancelled()') return false
    if (expr === 'true') return true
    if (expr === 'false') return false
    const fn = /^(startsWith|endsWith|contains)\(\s*([A-Za-z0-9_.]+)\s*,\s*'([^']*)'\s*\)$/.exec(expr)
    if (fn) {
        const actual = String(contextValue(ctx, fn[2]))
        if (fn[1] === 'startsWith') return actual.startsWith(fn[3])
        if (fn[1] === 'endsWith') return actual.endsWith(fn[3])
        return actual.includes(fn[3])
    }
    const cmp = /^([A-Za-z0-9_.]+)\s*(==|!=)\s*'([^']*)'$/.exec(expr)
    if (cmp) {
        const equal = String(contextValue(ctx, cmp[1])) === cmp[3]
        return cmp[2] === '==' ? equal : !equal
    }
    throw new Error(`unsupported condition atom ${JSON.stringify(expr)}`)
}

/** Strip an optional `${{ … }}` wrapper; the value inside is what GitHub evaluates. */
function unwrapExpression (raw) {
    const s = String(raw).trim()
    const m = /^\$\{\{([\s\S]*)\}\}$/.exec(s)
    return (m ? m[1] : s).trim()
}

function conditionHolds (raw, ref, eventName) {
    return evaluate(unwrapExpression(raw), refContext(ref, eventName))
}

/** A branch push in every shape it can take: our branch, another branch, a PR. */
const NON_RELEASE_REFS = [REF_BRANCH, REF_OTHER_BRANCH, REF_PR]

// ---------------------------------------------------------------------------------------------
// The contract. Returns a list of human-readable problems; empty means the workflow is correct.
// ---------------------------------------------------------------------------------------------
function validate (doc) {
    const problems = []
    const add = (m) => problems.push(m)
    const guard = (fn, label) => { try { fn() } catch (e) { add(`${label}: ${e.message}`) } }

    const trig = triggersOf(doc)
    if (!trig) {
        add('no `on:` block — the workflow cannot be triggered at all')
        return problems
    }
    const on = trig.value
    if (on === null) {
        add('`on:` is empty — a null trigger block declares no events')
        return problems
    }
    if (typeof on !== 'object' || Array.isArray(on)) {
        if (asList(on).includes('push')) add('`on: [push]` triggers every branch, not only smartssh')
        else add(`\`on:\` must be a mapping of events, got ${JSON.stringify(on)}`)
        return problems
    }

    // --- trigger events -----------------------------------------------------------------------
    if (!Object.hasOwn(on, 'push')) add('on.push is missing — a push to the smartssh branch never runs the gate')
    else {
        const push = on.push === null ? {} : on.push
        if (typeof push !== 'object' || Array.isArray(push)) add(`on.push must be a mapping, got ${JSON.stringify(on.push)}`)
        else {
            const branches = asList(push.branches)
            if (!branches.includes('smartssh')) {
                add(`on.push.branches must include 'smartssh', got ${JSON.stringify(push.branches)}`)
            }
            const tags = asList(push.tags)
            if (!tags.includes('v*')) {
                add(`on.push.tags must include 'v*', got ${JSON.stringify(push.tags)} — the tag build would stop firing`)
            }
            if (asList(on.push.branches).length === 0 && push.branches !== undefined) {
                add('on.push.branches is present but empty — GitHub treats that as "every branch"')
            }
        }
    }
    if (!Object.hasOwn(on, 'workflow_dispatch')) add('on.workflow_dispatch is missing — the manual run was removed')

    // --- the cheap half must always run ------------------------------------------------------
    const steps = stepsOf(doc)
    if (!steps) {
        add('jobs.portable.steps is missing — there is no job to run the gate in')
        return problems
    }
    for (const id of GATE_STEP_IDS) {
        guard(() => {
            const step = findStep(steps, { id })
            if (step.if === undefined) return
            const cond = String(step.if)
            if (!conditionHolds(cond, REF_BRANCH)) {
                add(`gate step '${id}' is skipped on a branch push (\`if: ${cond}\`) — the gate must run on every push to smartssh`)
            }
            if (!conditionHolds(cond, REF_TAG)) {
                add(`gate step '${id}' is skipped on a tag push (\`if: ${cond}\`) — the tag path must keep running it`)
            }
        }, `gate step '${id}'`)
    }

    // --- packaging and release must stay off a branch push ------------------------------------
    for (const selector of [...PACKAGING_STEPS, ...RELEASE_STEPS]) {
        guard(() => {
            const step = findStep(steps, selector)
            const label = selector.label
            if (step.if === undefined || step.if === null || String(step.if).trim() === '') {
                add(`${label} has no \`if:\` — a branch push would run it and could ship an exe/draft release`)
                return
            }
            const cond = String(step.if)
            if (!conditionHolds(cond, REF_TAG)) {
                add(`${label} is skipped on a tag push (\`if: ${cond}\`) — the tag path must still package and release`)
            }
            for (const ref of NON_RELEASE_REFS) {
                if (conditionHolds(cond, ref)) {
                    add(`${label} runs for ${ref} (\`if: ${cond}\`) — a branch push must never reach packaging or a release`)
                }
            }
            // A manually dispatched run may still build the dev exe it always did, but it must never
            // open a release: draft or not, that is a human decision tied to a version tag.
            if (RELEASE_STEPS.includes(selector) && conditionHolds(cond, REF_BRANCH, 'workflow_dispatch')) {
                add(`${label} runs on a manual dispatch (\`if: ${cond}\`) — releases are tag-only`)
            }
        }, selector.label)
    }

    // --- cost guards that make the branch trigger affordable ---------------------------------
    if (doc?.concurrency?.['cancel-in-progress'] !== true) {
        add('concurrency.cancel-in-progress must be true — successive pushes would each spend a full runner slot')
    }
    if (typeof doc?.concurrency?.group !== 'string' || !doc.concurrency.group.includes('github.ref')) {
        add('concurrency.group must be keyed on github.ref so a new push supersedes the run it replaces')
    }
    if (doc?.permissions?.contents !== 'write') {
        add('permissions.contents must stay "write" — the status commit is how a token-free reader sees the outcome')
    }

    return problems
}

// ---------------------------------------------------------------------------------------------
// 1. The real workflow must be valid.
// ---------------------------------------------------------------------------------------------
let source = ''
let doc = null
try {
    source = fs.readFileSync(WORKFLOW_PATH, 'utf8')
} catch (e) {
    process.stdout.write(`FAIL cannot read ${path.relative(REPO_ROOT, WORKFLOW_PATH)} :: ${e.message}\n0/0 passed\n`)
    process.exit(1)
}

t('yaml parses the workflow file', () => {
    doc = yaml.load(source)
    if (!doc || typeof doc !== 'object') throw new Error('parsed to a non-object')
})

t('workflow validates with zero problems', () => {
    const problems = validate(doc)
    if (problems.length > 0) throw new Error(`${problems.length} problem(s):\n      - ${problems.join('\n      - ')}`)
})

t('tag push still reaches packaging and release (tag path unchanged)', () => {
    const steps = stepsOf(doc)
    for (const sel of [...PACKAGING_STEPS, ...RELEASE_STEPS]) {
        const step = findStep(steps, sel)
        if (!conditionHolds(step.if, REF_TAG)) throw new Error(`${sel.label} would not run on a tag`)
    }
})

t('manual dispatch still packages but never releases (unchanged from before)', () => {
    const steps = stepsOf(doc)
    for (const sel of PACKAGING_STEPS) {
        const step = findStep(steps, sel)
        if (!conditionHolds(step.if, REF_BRANCH, 'workflow_dispatch')) {
            throw new Error(`${sel.label} no longer runs on a manual dispatch — that route used to build the dev exe`)
        }
    }
    const release = findStep(steps, RELEASE_STEPS[0])
    if (conditionHolds(release.if, REF_BRANCH, 'workflow_dispatch')) throw new Error('a manual dispatch would open a release')
})

t('branch push runs the four gate steps and skips packaging', () => {
    const steps = stepsOf(doc)
    for (const id of GATE_STEP_IDS) {
        const step = findStep(steps, { id })
        if (step.if !== undefined && !conditionHolds(step.if, REF_BRANCH)) throw new Error(`gate step ${id} skipped on branch push`)
    }
    for (const sel of [...PACKAGING_STEPS, ...RELEASE_STEPS]) {
        const step = findStep(steps, sel)
        if (conditionHolds(step.if, REF_BRANCH)) throw new Error(`${sel.label} would run on a branch push`)
    }
})

// ---------------------------------------------------------------------------------------------
// 2. Every assertion must be able to fail. Each mutation breaks exactly one rule and must produce a
//    problem naming that rule — a mutation caught by some *other* assertion proves nothing.
// ---------------------------------------------------------------------------------------------
const clone = () => structuredClone(doc)
const trig = (d) => triggersOf(d).value
const step = (d, sel) => findStep(stepsOf(d), sel)

const MUTATIONS = [
    ['push trigger removed', (d) => { delete trig(d).push }, /on\.push/],
    ['push.branches no longer names smartssh', (d) => { trig(d).push.branches = ['main'] }, /on\.push\.branches/],
    ['push.branches emptied', (d) => { trig(d).push.branches = [] }, /on\.push\.branches/],
    ['push.tags drops v*', (d) => { trig(d).push.tags = ['release-*'] }, /on\.push\.tags/],
    ['workflow_dispatch removed', (d) => { delete trig(d).workflow_dispatch }, /on\.workflow_dispatch/],
    ['supposedly tag-only trigger block is dropped', (d) => { delete d.jobs.portable.steps; }, /jobs\.portable\.steps/],
    ['portable step loses its guard', (d) => { delete step(d, { id: 'portable' }).if }, /Portable exe/],
    ['portable step widened to always()', (d) => { step(d, { id: 'portable' }).if = 'always()' }, /Portable exe/],
    ['portable step widened in the ${{ }} form', (d) => { step(d, { id: 'portable' }).if = "${{ github.event_name == 'push' }}" }, /Portable exe/],
    ['portable step widened to every branch push', (d) => { step(d, { id: 'portable' }).if = "github.ref_type == 'branch'" }, /Portable exe/],
    ['hash step loses its guard', (d) => { delete step(d, { id: 'hash' }).if }, /Hash \+ version/],
    ['hash step widened to a branch push', (d) => { step(d, { id: 'hash' }).if = "github.event_name != 'pull_request'" }, /Hash \+ version/],
    ['draft release loses its guard', (d) => { delete step(d, { name: 'Draft release' }).if }, /Draft release/],
    ['draft release widened to always()', (d) => { step(d, { name: 'Draft release' }).if = 'always()' }, /Draft release/],
    ['draft release opened by a manual dispatch', (d) => { step(d, { name: 'Draft release' }).if = "startsWith(github.ref, 'refs/tags/v') || github.event_name == 'workflow_dispatch'" }, /Draft release/],
    ['tests step disabled on a branch push', (d) => { step(d, { id: 'tests' }).if = "github.ref_type == 'tag'" }, /gate step 'tests'/],
    ['install step disabled on a branch push', (d) => { step(d, { id: 'install' }).if = "startsWith(github.ref, 'refs/tags/')" }, /gate step 'install'/],
    ['webpack step disabled on a branch push', (d) => { step(d, { id: 'webpack' }).if = 'false && true' }, /gate step 'webpack'/],
    ['buildinfo step disabled on a branch push', (d) => { step(d, { id: 'buildinfo' }).if = 'success() && false' }, /gate step 'buildinfo'/],
    ['concurrency cancellation turned off', (d) => { d.concurrency['cancel-in-progress'] = false }, /cancel-in-progress/],
    ['permissions.contents downgraded', (d) => { d.permissions.contents = 'read' }, /permissions\.contents/],
    ['a condition using an unknown context is reported, not ignored', (d) => { step(d, { id: 'hash' }).if = "github.actor == 'x'" }, /Hash \+ version/],
]

for (const [name, mutate, expected] of MUTATIONS) {
    t(`mutation rejected: ${name}`, () => {
        const d = clone()
        mutate(d)
        const problems = validate(d)
        if (problems.length === 0) throw new Error('workflow still validates — this assertion cannot fail')
        const hit = problems.find((p) => expected.test(p))
        if (!hit) throw new Error(`expected a problem matching ${expected}, got:\n      - ${problems.join('\n      - ')}`)
    })
}

// 'false && true' / 'success() && false' are valid atoms; make sure the mutation table above is not
// relying on the evaluator throwing for them.
t('evaluator handles the shapes used above', () => {
    for (const ref of [REF_TAG, REF_BRANCH, REF_PR]) {
        if (conditionHolds('false && true', ref) !== false) throw new Error('false && true must be false')
        if (conditionHolds('success() && false', ref) !== false) throw new Error('success() && false must be false')
        if (conditionHolds('true || false', ref) !== true) throw new Error('true || false must be true')
    }
    if (conditionHolds("startsWith(github.ref, 'refs/tags/v')", REF_TAG) !== true) throw new Error('tag prefix must match a v tag')
    if (conditionHolds("startsWith(github.ref, 'refs/tags/v')", REF_BRANCH) !== false) throw new Error('tag prefix must not match a branch')
})

t('evaluator refuses an atom it does not understand', () => {
    let threw = false
    try {
        conditionHolds("github.actor == 'someone'", REF_TAG)
    } catch {
        threw = true
    }
    if (!threw) throw new Error('an unknown atom must throw, so a new `if:` cannot slip past unparsed')
})

// ---------------------------------------------------------------------------------------------
const passed = r.filter(([s]) => s === 'PASS').length
const failed = r.filter(([s]) => s === 'FAIL')
for (const [status, name] of r) {
    process.stdout.write(`${status} ${name}\n`)
}
if (failed.length > 0) {
    process.stdout.write(`\n${passed}/${r.length} passed, ${failed.length} FAILED\n`)
    process.exitCode = 1
} else {
    process.stdout.write(`\n${passed}/${r.length} passed\n`)
    process.exitCode = 0
}
