# v1.0.246 six-step gate on VM 210 — PASS (51 pass / 0 fail / 0 skipped, 1 live measurement)

- Tag `v1.0.246` → commit `3de34c353c2c565244718261a296fe7dacab1464` (`merge(t_fcfb11af)`).
- CI run **27** (`ci-status/27.json`): `status: success`, all six steps `success`, `packaging.ok: true`
  (12 builtin plugins, `SMARTSSH_MEASURE` symbol count 11, 1517 payload entries under `resources/builtin-plugins/`).
- `sha256 = 2D3DC94125E8EC7FBFFB271A5DC18AC0CAEE7FC480EBA18FE4FC6785D1210CC2`, `exe` 127 720 510 bytes (121.8 MB).
- Downloaded the draft asset (`/releases/assets/803631748`, release `461374923` — `v1.0.246`, draft) and cross-checked
  the same bytes inside the run's own upload artifact (`15253058286`): both hashes equal the CI hash above.
  The guest re-computed the hash of the staged file before the run (`windows-measure-2d3dc941.log` line 3).
- Build identity: `windows-buildinfo-2d3dc941.json` = `{"base":"1.0.246","build":"sms.27","commit":"3de34c3",
  "builtAt":"2026-11-28T07:10:41Z"}`, staged as `resources\extras\smartssh-buildinfo.json` next to the exe.

## Gate values (machine-read)

| Gate | Required | Actual | Evidence |
|---|---|---|---|
| six-step checklist | `ALL CHECKS PASSED (skipped: 0)` | `ALL CHECKS PASSED (skipped: 0)`, exit 0 | `windows-checklist-2d3dc941.log` tail |
| live measurements | `>= 1/3` | `live measurements: 1/3` (case `683x512` `measured:true`, `dprSource:runtime`) | `windows-metrics-2d3dc941.json` |
| judge | no FAIL | `51 pass / 0 fail / 0 skipped` | checklist stdout |
| metrics `build.sha256` | == exe sha256 | `2D3DC941…` == `2D3DC941…` | checklist line `metrics build.sha256 matches the exe under test` |
| metrics `build.commit` | == tagged commit | `3de34c3` | metrics `build` block |
| screenshot | app running + real terminal tab | tab `1 Welcome` / `2 Administrator: C:\Win…`; terminal prints `Smart SSH`, `1.0.246`, the exe sha256, `sms.27 / 3de34c3`, `powershell(7344) <- cmd.exe(4604) <- Smart SSH.exe(1140)` and `SMARTSSH_PROBE_OK` | `windows-screenshot-2d3dc941.png` |

The two declared-but-unmeasured cases are labelled, not faked: `911x512` and `900-high-split` carry
`measurementNote: "runtime window 1280x752 is not case …"` — in measure mode the window *is* the case geometry
(`SMARTSSH_MEASURE_CASE`, default `683x512`), so at most one case can be `measured:true` per app start.
`live measurements: 1/3` is the expected healthy value; `0/3` is the failure this gate was fixed for.

## What the fix changed (visible in the artifact)

`t_fcfb11af` (`fe42e76`) moved the viewport capture into `emit()`, i.e. while the tab is alive:

- `[15:23:16] try1 … metrics=True` — the file existed **as soon as the terminal tab existed**, with no proposal
  and no relay token (`token_empty`), before anything was typed.
- `[15:23:30] after_typing metrics=True`, `[15:23:39] after_close_tab metrics=True` — closing the tab did not
  rewrite `measured:true` back to declared.
- `stray_cwd_relative=False` — no `C:\data\metrics.json`; the path stayed rooted at the exe directory.

## Reproduce

```
C:\work\accept246\
  smartssh-1.0.246-portable-x64.exe
  resources\extras\smartssh-buildinfo.json     # without this the writer throws and writes nothing
  smartssh\{verify,core,app}\...               # windows-checklist.ps1 from tag v1.0.246
  measure246.ps1  check246.ps1  shot246.ps1  ident246.ps1

$env:SMARTSSH_MEASURE=1 ; start the exe ; Ctrl+Shift+T ; type a command ; Ctrl+Shift+W
powershell -File smartssh\verify\windows-checklist.ps1 -Exe <exe> -ExpectedSha <sha> -MetricsPath <exe dir>\data\metrics.json
```

Driven through an interactive scheduled task (`/it /rl highest`) because an SSH shell is session 0 and cannot
drive session-1 windows; the screenshot is a QMP `screendump`, the only trustworthy view of the desktop.
