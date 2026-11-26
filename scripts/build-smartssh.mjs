#!/usr/bin/env node
// SmartSSH portable build: electron-builder target=portable (single exe, no installer).
// Data dir is redirected at runtime via PORTABLE_EXECUTABLE_DIR (see app bootstrap patch).
import { build as builder } from "electron-builder"
import * as vars from "./vars.mjs"

process.env.ARCH = process.env.ARCH || "x64"

await builder({
    dir: false,
    win: ["portable"],
    config: {
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
