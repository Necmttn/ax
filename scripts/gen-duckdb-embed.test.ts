import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeManifestFromDylib, writeStub } from "./gen-duckdb-embed.ts";

const genFile = join(import.meta.dir, "../apps/axctl/src/duckdb-embed.gen.ts");

describe("DuckDB embed code generation", () => {
    afterEach(() => writeStub());

    test("writeStub restores a source-safe empty module", () => {
        writeStub();

        expect(readFileSync(genFile, "utf8")).toContain(
            "export const DUCKDB_DYLIB: string | undefined = undefined;",
        );
    });

    test("the manifest embeds the selected dynamic library as a Bun file", () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-duckdb-embed-"));
        const dylib = join(dir, "libduckdb.dylib");
        writeFileSync(dylib, "fixture");

        try {
            writeManifestFromDylib(dylib);
            const manifest = readFileSync(genFile, "utf8");
            expect(manifest).toContain('with { type: "file" }');
            expect(manifest).toContain(
                "export const DUCKDB_DYLIB: string | undefined = duckdbDylib;",
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
