#!/usr/bin/env node
// SmartSSH installer build: electron-builder target=nsis — an *assisted* setup.exe (wizard, the user
// picks the install directory) that creates a Start Menu entry, a desktop shortcut and a Control
// Panel uninstall entry.
//
// Why a separate script and not a flag on build-smartssh.mjs: that script is the portable build, and
// everything about it is load-bearing — app/lib/portable.ts redirects userData only when
// PORTABLE_EXECUTABLE_DIR is set, windows-checklist.ps1 measures that exe, and packaging evidence is
// keyed to its name. Adding a second target there would make one script produce two artifacts whose
// names the status/checklist path cannot tell apart. So the portable script keeps its single target
// and this one adds the second.
//
// Identity is duplicated on purpose and must stay in lockstep with scripts/build-smartssh.mjs:
// productName "Smart SSH", appId "com.smartssh.app". That is what lets the installed copy and the
// portable copy share a name while staying separate installs — the portable one keeps its data in
// <exe dir>/data, the installed one uses the normal Electron userData path (no
// PORTABLE_EXECUTABLE_DIR in an installed launch).
// smartssh/verify/installer-config.test.mjs fails the build if the two scripts drift, if either
// script turns on `oneClick`, or if the nsis block stops being an assisted installer.
//
// Run after the portable build in the same job, so the packaged tree and the builtin-plugins staging
// are already in place:
//   node scripts/build-smartssh-installer.mjs
import { build as builder } from "electron-builder"
import * as vars from "./vars.mjs"

process.env.ARCH = process.env.ARCH || "x64"

await builder({
    dir: false,
    win: ["nsis"],
    // TOP-LEVEL, not inside `config`: app-builder-lib constructs its PublishManager from build()'s
    // top-level options (`new PublishManager(packager, options)`), so a `publish` inside `config` is
    // read by nobody. With no top-level policy, PublishManager detects CI and implies
    // "onTagOrDraft"; the nsis target emits an update-info artifact, and the resulting
    // GitHubPublisher throws "GitHub Personal Access Token is not set" *after* setup.exe was built —
    // which failed CI run 34 at this step and left ci-status/<run>.json without an `artifacts` key.
    // CI publishes the exes itself via upload-artifact / draft release, so never publish here.
    publish: "never",
    config: {
        productName: "Smart SSH",
        appId: "com.smartssh.app",
        extraMetadata: { version: vars.version },
        forceCodeSigning: false,
        win: {
            // Assisted installer only — never oneClick, never silent. The wizard, the shortcut and
            // uninstall behaviour all live in electron-builder.yml's `nsis:` block; this override
            // only selects the target and the arch.
            target: [{ target: "nsis", arch: ["x64"] }],
            signtoolOptions: undefined,
        },
    },
})
