# v1.0.245 six-step gate on VM 210 — FAILED on one check (honest 0/3 live measurement)

Build: `smartssh-1.0.245-portable-x64.exe`, sha256 `8227AA03098B54B0A75266385A63FEED8D8327AF5479882CA575669DA72A4015`,
exe bytes 127,705,770, buildinfo `1.0.245 · sms.24 · 51c5469`, CI run 24 (`ci-status/24.json`), tag `v1.0.245` at merge `51c5469`.

## Result
`windows-checklist.ps1` exit code **2** → `50 pass / 1 fail / 0 skipped`.

```
FAIL  at least one case is a live measurement (measured:true)
      no live measurement: 0 of 3 cases are measured:true; every case is a declared CASE_SPEC value,
      so nothing in this file describes this exe's real window
live measurements: 0/3 (measured:true only; declared cases excluded)
```

The 50 passing checks include the binary binding: `metrics build.sha256 matches the exe under test`
and `metrics build.commit matches the exe` — so the file really came from this exe's own run, it is
not hand-written and not borrowed from another build.

## What the merge actually changed (and what it did not)
The `t_0eef50fc` fix does exactly what it claims, and the evidence proves it:
* `measureWindow.mjs` sized the real window to the case geometry: the live renderer reports
  `innerWidth=683, innerHeight=512` — the ±2 px geometry gate is satisfied.
* The judge now refuses a zero-measurement file. Before this build the same 0/3 file passed as
  50/0/0; now it FAILs with the reason spelled out. That is the intended behaviour, not a regression.
* What is still missing is upstream of the judge: the renderer never hands a runtime viewport over.
  All three cases carry `measurementNote: "no runtime viewport was supplied"`, i.e.
  `measureSmartSSHCase()` returned `{}` on every tick.

## Evidence that narrows the remaining gap
A CDP probe of the live renderer (app started with `--remote-debugging-port=9222`) during the run:
```
innerW=683 innerH=512 dpr=1
.terminal.xterm present, 653x442 CSS px, terminal visibly running cmd.exe
```
So the window geometry and the xterm element are real and visible; the failing guard inside
`measureSmartSSHCase()` is therefore `this.frontend?.xterm` / `this.content?.nativeElement` /
`xterm.rows` — it never yields a reading, and the service correctly falls back to the declared case.

## Next step (for the code owner)
Have `measureSmartSSHCase()` report *which* guard rejected the reading, e.g. return
`{ measurementNote: 'no xterm' | 'no content el' | 'rows<=0' | 'dpr<=0' }`, so the next build names
the fault instead of proving the readout is empty. One CI cycle should then be enough.

## Files
* `windows-checklist-8227aa03.log` — full checklist stdout (exit 2)
* `windows-metrics-8227aa03.json` — the app's own `data\metrics.json` from the real UI run
* `windows-measure-8227aa03.log` — the measurement run log (window titles, tab open/type/close, no metrics path leak)
* `windows-screenshot-8227aa03.png` — maximised app, terminal tab in front, naming its own exe/ProductName/FileVersion
