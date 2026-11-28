# v1.0.245 six-step gate on VM 210 — PASS (51 pass / 0 fail / 0 skipped, 1 live measurement)

- Tag `v1.0.245` → commit `3de34c353c2c565244718261a296fe7dacab1464` (`merge(t_fcfb11af)` on top of `fe42e76`).
- CI run **25** (`ci-status/25.json`): `status: success`, all steps success, `packaging.ok: true`,
  `sha256 = 9E81CF9F87254BCE1EB4638393929C80A7800677165DA380D66F674B59FB2A08`, `exe` 121.8 MB.
- Downloaded the draft asset with the fine-grained PAT (`/releases/assets/803517005`), and the hash of the
  downloaded bytes equals the CI hash above. The same hash was re-computed **on the guest** from the staged
  file before the run (`windows-measure-9e81cf9f.log` line 2).
- Build identity: `windows-buildinfo-9e81cf9f.json` = `{"base":"1.0.245","build":"sms.25","commit":"3de34c3",
  "builtAt":"2026-11-28T06:25:54Z"}` — staged as `resources\extras\smartssh-buildinfo.json` next to the exe.

## Gate values (machine-read)

| Gate | Required | Actual | Evidence |
|---|---|---|---|
| six-step checklist | `ALL CHECKS PASSED (skipped: 0)` | `ALL CHECKS PASSED (skipped: 0)`, exit 0 | `windows-checklist-9e81cf9f.log` tail |
| live measurements | `>= 1/3` | `live measurements: 1/3` (case `683x512` `measured:true`, `dprSource:runtime`) | `windows-metrics-9e81cf9f.json` |
| judge | no FAIL | `51 pass / 0 fail / 0 skipped`, exit 0 | checklist stdout + `windows-judge-9e81cf9f.log` (host re-run) |
| metrics `build.sha256` | == exe sha256 | `9E81CF9F…` == `9E81CF9F…` | checklist line `metrics build.sha256 matches the exe under test` |
| screenshot | app window + real terminal tab content | tab bar `1 Welcome` / `2 Administrator: C:\Win…`, terminal shows `powershell(2976) <- cmd.exe(9872) <- Smart SSH.exe(1236)` | `windows-screenshot-9e81cf9f.png` |

The declared-but-unmeasured cases are labelled, not faked: `911x512` and `900-high-split` carry
`measurementNote: "runtime window 1280x752 is not case …"` after the screenshot run maximised the window.

## What the fix changed (visible in the artifact)

`t_fcfb11af` (`fe42e76`) made the capture independent of the proposal state machine and moved the disk write
into `emit()`, i.e. while the tab is alive. The run shows exactly that:

- `[14:36:30] try1 … metrics=True` — the file existed **as soon as the terminal tab existed**, with no proposal
  and no relay token (`token_empty`), before anything was typed.
- `[14:36:52] after_close_tab metrics=True` — closing the tab did not rewrite `measured:true` back to declared.

## Reproduce

```
# staging dir = exe + build identity + the repo's verify/core/app scripts
C:\work\accept245b\
  smartssh-1.0.245-portable-x64.exe
  resources\extras\smartssh-buildinfo.json     # <- without this the writer throws and writes nothing
  smartssh\{verify,core,app}\...               # windows-checklist.ps1 + judgeFailure.ps1 + metrics-check.mjs

$env:SMARTSSH_MEASURE=1 ; start the exe ; Ctrl+Shift+T ; type a command ; Ctrl+Shift+W
powershell -File smartssh\verify\windows-checklist.ps1 -Exe <exe> -ExpectedSha <sha> -MetricsPath <exe dir>\data\metrics.json
```

## Traps hit this run

1. **No build identity next to the exe ⇒ no metrics file at all.** `proposalService.mjs:603` throws
   `UI metrics need build identity: … ship resources/extras/smartssh-buildinfo.json next to the exe`, and the
   failure is silent in the UI. A first staging dir without `resources\extras\` produced an empty `data/`
   through a complete open-tab/type/close-tab cycle; the identical binary in a dir *with* the identity wrote
   `metrics.json` within seconds. Stage the buildinfo before blaming the writer.
2. **Two drivers on one guest collide.** `get-process` from an SSH (session 0) shell cannot see session-1
   windows — `MainWindowHandle` is 0 for every process, which reads as "the app is gone" while it is on screen.
   Drive and inspect through an interactive scheduled task (`/it /rl highest`) and treat a QMP screendump as
   the only trustworthy view of the desktop.
