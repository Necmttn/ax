// Phase 2: same E2E duckdb C-API exercise, but built into a single-file
// executable with `bun build --compile`. The dylib is embedded as a file
// asset; at runtime we detect whether we're running from inside the
// compiled binary's virtual filesystem ($bunfs) and, if so, extract the
// embedded bytes to a real tmpdir before dlopen (dlopen needs a real path
// on disk -- it cannot open a $bunfs virtual path directly).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDuckDBRoundTrip } from "./e2e";

// @ts-expect-error - "file" import attribute, resolved by Bun's bundler.
import dylibPath from "./libduckdb.dylib" with { type: "file" };

async function resolveDylibPath(): Promise<string> {
  const isEmbedded = dylibPath.startsWith("/$bunfs");
  console.log(`[phase2] import.meta path for dylib asset: ${dylibPath}`);
  console.log(`[phase2] running from compiled binary ($bunfs): ${isEmbedded}`);
  if (!isEmbedded) {
    // source mode (`bun run`) -- dylibPath is already a real file on disk.
    return dylibPath;
  }
  // compiled mode -- extract the embedded asset bytes to a real tmpdir.
  const t0 = performance.now();
  const bytes = await Bun.file(dylibPath).arrayBuffer();
  const dir = mkdtempSync(join(tmpdir(), "ax-duckdb-embed-"));
  const outPath = join(dir, "libduckdb.dylib");
  await Bun.write(outPath, bytes);
  const t1 = performance.now();
  console.log(
    `[phase2] extracted embedded dylib (${bytes.byteLength} bytes) to ${outPath} in ${(t1 - t0).toFixed(1)}ms`,
  );
  return outPath;
}

const cwdAtStart = process.cwd();
console.log(`[phase2] cwd at start: ${cwdAtStart}`);
console.log(`[phase2] process.execPath: ${process.execPath}`);

const resolvedPath = await resolveDylibPath();
const value = runDuckDBRoundTrip(resolvedPath, (s) => console.log(`[phase2] ${s}`));
console.log(`[phase2] PASS: end-to-end FFI round trip succeeded, value=${JSON.stringify(value)}`);
