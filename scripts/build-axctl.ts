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
// afterwards so the manifest never lands in git. The custom DuckDB dylib
// (gen-duckdb-embed.ts) and the hooks bundles (gen-hooks-embed.ts) follow the
// identical manifest -> compile -> stub pattern.
import { spawnSync } from "node:child_process";
import { writeManifest, writeStub } from "./gen-studio-embed.ts";
import {
    writeManifest as writeHooksManifest,
    writeStub as writeHooksStub,
} from "./gen-hooks-embed.ts";
import {
    writeManifestReusingBuild as writeDuckDbManifest,
    writeStub as writeDuckDbStub,
} from "./gen-duckdb-embed.ts";

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

/**
 * #880: the napi DuckDB driver. In a compiled binary `require.cache` cannot
 * intercept the BUNDLED module graph, so `@duckdb/node-bindings` (which would
 * otherwise drag in every platform's `duckdb.node` and load the OFFICIAL
 * libduckdb) is replaced with a shim that reads the staged addon off the
 * global `@ax/lib/duckdb`'s binding loader sets BEFORE importing
 * `@duckdb/node-api`. A Proxy, so property access is lazy - evaluation order
 * of the bundled graph cannot matter. The global's name is imported from the
 * loader so the two sides can never drift.
 */
import type { BunPlugin } from "bun";
import { AX_NAPI_BINDING_GLOBAL } from "../packages/lib/src/duckdb/binding.ts";

const bindingsShimPlugin: BunPlugin = {
    name: "ax-duckdb-bindings-shim",
    setup(build) {
        build.onResolve({ filter: /^@duckdb\/node-bindings$/ }, (args) => ({
            path: args.path,
            namespace: "ax-duckdb-bindings-shim",
        }));
        build.onLoad({ filter: /.*/, namespace: "ax-duckdb-bindings-shim" }, () => ({
            loader: "js",
            contents: `
module.exports = new Proxy({}, {
    get(_target, prop) {
        const binding = globalThis[${JSON.stringify(AX_NAPI_BINDING_GLOBAL)}];
        if (binding === undefined) {
            throw new Error(
                "@duckdb/node-bindings shim: the staged duckdb.node has not been loaded yet - " +
                "@ax/lib/duckdb's binding loader must run before @duckdb/node-api is used",
            );
        }
        return binding[prop];
    },
});
`,
        }));
    },
};

let status = 1;
try {
    writeManifest();
    writeHooksManifest();
    writeDuckDbManifest();
    const result = await Bun.build({
        entrypoints: [entry],
        compile: { outfile },
        define: { AX_BUILD_GIT: JSON.stringify(describe) },
        plugins: [bindingsShimPlugin],
        throw: false,
    });
    for (const log of result.logs) console.error(String(log));
    status = result.success ? 0 : 1;
} finally {
    // Always restore the committed empty stubs - even on a failed compile - so
    // the working tree never carries the generated manifests.
    writeStub();
    writeHooksStub();
    writeDuckDbStub();
}
process.exit(status);
