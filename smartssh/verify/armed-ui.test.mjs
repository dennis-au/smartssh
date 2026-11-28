// contract: v56
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = path => readFileSync(new URL(`../../tabby-terminal/src/${path}`, import.meta.url), 'utf8')
const pug = read('components/baseTerminalTab.component.pug')
const scss = read('components/baseTerminalTab.component.scss')
const component = read('api/baseTerminalTab.component.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

const chipStart = /^([ \t]*)\.smartssh-trust(?=[(\s]|$)/m
const proposalIf = /\*ngIf\s*=\s*(['"])\s*smartsshProposal\s*\1/

export function assertChipOutsideBar (pugText) {
    const chip = chipStart.exec(pugText)
    assert.ok(chip, 'trust chip is missing')
    // A root element cannot be inside the bar or another conditional Pug block.
    assert.equal(chip[1], '', 'trust chip must be outside the bar and at template root')
    const chipBlock = /^\.smartssh-trust[^\r\n]*(?:\r?\n(?:[ \t]+|\))[^\r\n]*)*/m.exec(pugText)[0]
    assert.doesNotMatch(chipBlock, proposalIf, 'trust chip must not be gated by smartsshProposal')
}

test('trust chip renders without a proposal', () => {
    assert.doesNotThrow(() => assertChipOutsideBar(pug))

    const barAndChip = /(^smartssh-bar[^\r\n]*\r?\n)(\.smartssh-trust\([\s\S]*?^\)[^\r\n]*)/m
    assert.match(pug, barAndChip)
    const nested = pug.replace(barAndChip, (_match, bar, chip) =>
        bar + chip.replace(/^/gm, '    '))
    assert.throws(() => assertChipOutsideBar(nested), /must be outside the bar/)

    const gated = pug.replace('.smartssh-trust(', '.smartssh-trust(\n    *ngIf=\'smartsshProposal\',')
    assert.throws(() => assertChipOutsideBar(gated), /must not be gated/)
})

test('trust chip binds the armed attribute and shows both trust labels', () => {
    assert.match(pug, /\[attr\.data-smartssh-armed\]\s*=\s*'smartsshArmed\s*\?\s*"true"\s*:\s*"false"'/)
    assert.match(pug, /唯讀自動 · 已武裝/)
    assert.match(pug, /信任：關/)
})

test('renderer wires relay work to the token and proposal entry points', () => {
    assert.match(component, /import\s*\{\s*createRelayWork\s*\}\s*from\s*'[^']*\/relayWork\.mjs'/)
    assert.match(component, /import\s*\{\s*promptSample\s*\}\s*from\s*'[^']*\/promptSample\.mjs'/)
    assert.equal([...component.matchAll(/\bcreateRelayWork\s*\(/g)].length, 1)
    assert.match(component, /\bapply:\s*\([^)]*\)\s*=>\s*this\.setSmartSSHProposalToken\s*\(/)
    assert.ok([...component.matchAll(/\bsetSmartSSHProposalToken\s*\(/g)].length >= 2)
    assert.ok([...component.matchAll(/\bproposeSmartSSHCommand\s*\(/g)].length >= 2)
})

test('Enter records a feed and enables prompt sampling in the same branch', () => {
    const sendInput = /^    sendInput\s*\([^\n]*\): void \{([\s\S]*?)^    \}/m.exec(component)?.[1] ?? ''
    const enterBranch = /if\s*\([^\n]*data\.includes\(0x0d\)\s*\|\|\s*data\.includes\(0x0a\)[^\n]*\)\s*\{([^{}]*)\}/.exec(sendInput)?.[1] ?? ''
    assert.match(enterBranch, /this\.smartsshProposalService\.noteFeed\(\)/)
    assert.match(enterBranch, /this\.smartsshFeedSinceSample\s*=\s*true\b/)
})

test('trust chip is out of layout, click-through, and has an armed state', () => {
    const chipStyle = /^    > \.smartssh-trust\s*\{([\s\S]*?)^    \}/m.exec(scss)?.[1] ?? ''
    assert.match(chipStyle, /^ {8}position:\s*absolute;/m)
    assert.match(chipStyle, /^ {8}pointer-events:\s*none;/m)
    assert.match(chipStyle, /^ {8}&\.armed\s*\{/m)
})

test('stopping the proposal service stops the relay work loop first', () => {
    assert.match(component, /\bstopSmartSSHProposal\s*\(\): void \{\s*this\.smartsshRelayWork\?\.stop\(\)/)
})
