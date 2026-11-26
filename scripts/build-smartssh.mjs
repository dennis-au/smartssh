#!/usr/bin/env node
// SmartSSH portable build: electron-builder target=portable (single exe, no installer).
// Data dir is redirected at runtime via PORTABLE_EXECUTABLE_DIR — see app/lib/portable.ts (imported
// from app/lib/index.ts before app.whenReady) and smartssh/app/portablePath.mjs for the rules.
//
// This file is the only place product identity is overridden: electron-builder.yml keeps the
// upstream Tabby identity so the normal Tabby build is unaffected, and this config wins on merge.
// The icon is deliberately NOT overridden (still ./build/windows/icon.ico) — new artwork is an
// operator decision, not a build-script one.
import { build as builder } from "electron-builder"
import * as vars from "./vars.mjs"

process.env.ARCH = process.env.ARCH || "x64"

await builder({
    dir: false,
    win: ["portable"],
    config: {
        productName: "Smart SSH",
        appId: "com.smartssh.app",
        extraMetadata: { version: vars.version },
        publish: undefined,
        forceCodeSigning: false,
        win: {
            target: [{ target: "portable", arch: ["x64"] }],
            artifactName: "smartssh-${version}-portable-${arch}.${ext}",
            signtoolOptions: undefined,
        },
    },
})
