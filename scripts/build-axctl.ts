#!/usr/bin/env bun
// Build the axctl single-file binary, baking the git provenance (a `git describe`
// string) into AX_BUILD_GIT. This lets `axctl -v` report which tag/sha the binary
// was built from even though a compiled binary has no source tree to read git from.
//
// Usage: bun scripts/build-axctl.ts [entry] [outfile]
//
// The studio SPA is baked into the binary: writeManifest() builds the studio
// daemon target and rewrites studio-embed.gen.ts with `{ type: "file" }` imports
// so `bun build --compile` embeds the assets (the binary has no source tree to
// read apps/studio/dist from). writeStub() restores the committed empty stub
// afterwards so the manifest never lands in git.
import { spawnSync } from "node:child_process";
import { writeManifest, writeStub } from "./gen-studio-embed.ts";
import {
    writeManifest as writeHooksManifest,
    writeStub as writeHooksStub,
} from "./gen-hooks-embed.ts";

const entry = process.argv[2] ?? "apps/axctl/src/cli/index.ts";
const outfile = process.argv[3] ?? "dist/axctl";

function gitDescribe(): string {
    const res = spawnSync(
        "git",
        ["describe", "--tags", "--always", "--dirty", "--long"],
        { encoding: "utf8" },
    );
    const out = res.status === 0 ? res.stdout.trim() : "";
    return out || "unknown";
}

const describe = gitDescribe();

let status = 1;
try {
    writeManifest();
    writeHooksManifest();
    const result = spawnSync(
        "bun",
        [
            "build",
            "--compile",
            "--define",
            `AX_BUILD_GIT="${describe}"`,
            "--outfile",
            outfile,
            entry,
        ],
        { stdio: "inherit" },
    );
    status = result.status ?? 1;
} finally {
    // Always restore the committed empty stubs - even on a failed compile - so
    // the working tree never carries the generated manifests.
    writeStub();
    writeHooksStub();
}
process.exit(status);
