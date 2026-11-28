# Smart SSH 1.0.247 — branding verification on VM 210

- tag `v1.0.247` → commit `85ed6e4` (merge of `t_8be9bfa3`, branding purge)
- CI run **31** (workflow_dispatch/push on refs/tags/v1.0.247), all steps success
- exe `smartssh-1.0.247-portable-x64.exe`, 127,719,041 B,
  sha256 `44d3cb3364c8e8ace03ca23cd3e655ca7e3225510ae7845384aeabe6d33fdcc9`
  (identical in `ci-status/31.json`, in the GitHub release asset digest and on the guest after download)
- guest: VM 210 `win-accept`, Windows 11 Enterprise Eval 24H2, session 1 (interactive), staged at
  `C:\work\accept247` with `resources\extras\smartssh-buildinfo.json`
  = `{base 1.0.247, build sms.31, commit 85ed6e4, builtAt 2026-11-28T09:06:35Z}`

## What was seen on screen

| # | Surface | Evidence file | Result |
|---|---|---|---|
| 1 | First-run **Welcome** page | `windows-branding-welcome-44d3cb33.png` (renderer capture) | "Thank you for downloading Smart SSH!"; DOM `innerText` has 4 × "Smart SSH", **0 × "Tabby"** |
| 2 | **Window title** | `windows-branding-titlebar-44d3cb33.png` (Alt+Tab switcher) | title reads `Smart SSH`; `GetWindowText` = `Smart SSH` |
| 3 | **About** surface | `windows-branding-startpage-44d3cb33.png` | Windows build has **no menu bar at all** — see below |

Renderer dump of the Welcome page (`node dom.mjs` over CDP):

```
"welcome": "Thank you for downloading Smart SSH! Language Automatic Afrikaans ..."
"tabbyCount": 0, "smartCount": 4, "menuBars": 0
```

## The About box does not exist on the Windows build (finding, not a regression)

`Help → About` is a macOS/Linux app-menu item. The shipped bundle carries exactly one About string —
`{ role: 'about', label: 'About Smart SSH' }` in `app/lib/app.ts:303` — and the Windows window removes
the menu bar entirely (`app/lib/window.ts:177`, `process.platform !== 'darwin'` → `this.window.setMenu(null)`).

Measured on the guest:

```
GetMenu(hwnd) = 0  → no menu attached → no Help menu → no About item   (ui-menu.ps1)
app.asar: "About Smart SSH" ×1, "About Tabby" ×0                       (asar-check.ps1)
DOM: menuBars = 0, no "About" element anywhere                         (dom.mjs)
```

So there is nothing to photograph and nothing that can say "Tabby": the About label in the shipped
bundle is `About Smart SSH`, and it is not reachable from the Windows UI. The nearest user-visible
identity surface on Windows is the start page (`Smart SSH` + `Version: 1.0.247`) and the OS window
title (`Smart SSH`), both captured above.

**Decision needed from the operator:** if an in-app About/diagnostics dialog is wanted on Windows it is
a product change (new component + gate), not a branding fix.

## Six-step checklist (same exe, same guest)

`windows-checklist.ps1 -Exe …1.0.247… -ExpectedSha 44d3cb… -MetricsPath …\data\metrics.json`

```
51 pass / 0 fail / 0 skipped
live measurements: 1/3 (measured:true only; declared cases excluded)
ALL CHECKS PASSED (skipped: 0)
```

Both required numbers are present: `ALL CHECKS PASSED (skipped: 0)` and `live measurements: 1/3`.
The one live case (`683x512`) carries `dprSource: runtime`, `build.sha256` bound to the exe under test,
and honest trust state (`trust: watch`, `armed: false`, `gateReason: token_empty`) — no fabricated arm.

## Packaging gate (CI, run 31)

```
tabby-terminal bundle has 0 user-facing "Tabby" strings   ok=true  count=0
plugin count   12 dirs (>= 12)
exe payload carries builtin-plugins   1517 entries under resources/builtin-plugins/ via 7z
```

`packaging.ok = true` for stage `packaged`.

## Untouched by this pass

LICENSE, upstream copyright lines, `@tabby-gang/*` scopes and the README fork section were not edited
(see the whitelist in `smartssh/verify/brandingRules.mjs`).
