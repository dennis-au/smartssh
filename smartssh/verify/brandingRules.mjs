/**
 * Branding scan rules shared by the source gate (`check-branding.mjs`) and the shipped-bundle gate
 * (`scripts/verify-packaging.mjs`).
 *
 * The rule is one-directional: every occurrence of the upstream brand `Tabby` has to be *user-facing*
 * or *whitelisted*. User-facing means it can reach a screen, a window title, a tray tooltip, a modal,
 * a context-menu label or a terminal message. Whitelisted means it is provenance or an identifier
 * that must not be renamed:
 *
 *   - npm scope (`@tabby-gang/*`) and upstream URLs (github.com/EugenePamyatnykh/*)
 *   - upstream copyright lines / LICENSE references
 *   - code symbols (`TabbyCorePlugin`, `TabbyFormatedDatePipe`, `openTabbyWebInfo`, ...): rename is a
 *     refactor with no user-visible payoff, and it churns every import site
 *   - Windows registry keys (`...\\shell\\Tabby`): they are installation state, not displayed text;
 *     renaming them would orphan the keys of existing installs
 *   - macOS `.workflow` bundle file names: they are files on disk (resource identifiers)
 *
 * Comments are masked before scanning: a comment is never user-facing, and it is where the upstream
 * attribution ("Behaviour kept from upstream Tabby") lives.
 */

export const BRAND = 'Tabby'
export const REPLACEMENT = 'Smart SSH'

/** Extensions a source scan reads. */
export const SCAN_EXTENSIONS = ['.ts', '.html', '.pug']

/**
 * Blank out comments while keeping offsets (and therefore line numbers) byte-for-byte stable.
 * Line comments are `//...` and pug's `//-...`; the lookbehind keeps `https://` inside a URL intact.
 * The block-comment opener is guarded so a glob such as `src/**\/*.ts` is not mistaken for a comment.
 */
export function maskComments (text) {
    const blank = (match) => match.replace(/[^\n]/g, ' ')
    return text
        .replace(/(?<![\w'"`/])\/\*[\s\S]*?\*\//g, blank)
        .replace(/<!--[\s\S]*?-->/g, blank)
        .replace(/(?<![:\\])\/\/[^\n]*/g, blank)
}

/** Start offset of every line, so `index -> {line, col}` is a binary search instead of a re-scan. */
function lineStarts (text) {
    const starts = [0]
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') starts.push(i + 1)
    }
    return starts
}

function positionOf (starts, index) {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (starts[mid] <= index) lo = mid
        else hi = mid - 1
    }
    return { line: lo + 1, col: index - starts[lo] + 1 }
}

/** The quoted literal containing `index` on its line, or '' when the occurrence is bare text. */
function enclosingLiteral (text, index) {
    const lineStart = text.lastIndexOf('\n', index - 1) + 1
    const nextNewline = text.indexOf('\n', index)
    const lineEnd = nextNewline === -1 ? text.length : nextNewline
    const line = text.slice(lineStart, lineEnd)
    const col = index - lineStart
    for (const quote of ["'", '"', '`']) {
        const open = line.lastIndexOf(quote, col - 1)
        const close = line.indexOf(quote, col + BRAND.length)
        if (open !== -1 && open < col && close !== -1) {
            return line.slice(open + 1, close)
        }
    }
    return ''
}

/**
 * Why this occurrence may stay, or null when it is a user-facing hit.
 * `masked` is the comment-stripped text (same offsets as the raw text).
 */
export function whitelistReason (masked, index, rawLine) {
    const after = masked[index + BRAND.length] ?? ''
    // TabbyCorePlugin / TabbyFormatedDatePipe / openTabbyWebInfo: a symbol, not a sentence
    if (/[A-Za-z0-9_$]/.test(after)) {
        return 'code-identifier'
    }

    const literal = enclosingLiteral(masked, index)

    if (/@tabby-gang\/[\w.-]+/.test(rawLine)) {
        return 'npm-scope'
    }
    if (/https?:\/\/github\.com\/EugenePamyatnykh\//.test(rawLine)) {
        return 'upstream-url'
    }
    if (/copyright/i.test(rawLine)) {
        return 'copyright'
    }
    if (/(^|[\\/])Software[\\/]+Classes[\\/]|HK\.CU/i.test(literal)) {
        return 'registry-key'
    }
    if (/\.workflow$/.test(literal.trim())) {
        return 'resource-filename'
    }
    return null
}

/**
 * Every non-whitelisted `Tabby` in `text`, with the caller-supplied label as the file name so the
 * result stays free of absolute paths (the packaging report is published on a public branch).
 */
export function findBrandingHits (text, { file = '<text>' } = {}) {
    const masked = maskComments(text)
    const starts = lineStarts(masked)
    const rawLines = text.split('\n')
    const hits = []
    let index = masked.indexOf(BRAND)
    while (index !== -1) {
        const { line, col } = positionOf(starts, index)
        const rawLine = rawLines[line - 1] ?? ''
        if (!whitelistReason(masked, index, rawLine)) {
            hits.push({ file, line, col, text: rawLine.trim() })
        }
        index = masked.indexOf(BRAND, index + BRAND.length)
    }
    return hits
}
