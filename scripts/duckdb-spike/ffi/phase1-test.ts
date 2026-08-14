// Phase 1: source-mode bun:ffi against libduckdb.dylib (run with `bun run`).
import { existsSync } from "node:fs";
import { runDuckDBRoundTrip } from "./e2e";

const dylibPath = process.argv[2];
if (!dylibPath || !existsSync(dylibPath)) {
  console.error("usage: bun run phase1-test.ts <path-to-libduckdb.dylib>");
  process.exit(1);
}

runDuckDBRoundTrip(dylibPath, (s) => console.log(`[phase1] ${s}`));
console.log("[phase1] PASS: end-to-end FFI round trip against libduckdb.dylib succeeded");
