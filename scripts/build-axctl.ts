#!/usr/bin/env bun
// Build the axctl single-file binary, baking the git provenance (a `git describe`
// string) into AX_BUILD_GIT. This lets `axctl -v` report which tag/sha the binary
// was built from even though a compiled binary has no source tree to read git from.
//
// Usage: bun scripts/build-axctl.ts [entry] [outfile]
import { spawnSync } from "node:child_process";

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
process.exit(result.status ?? 1);
