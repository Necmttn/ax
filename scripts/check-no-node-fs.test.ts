import { describe, expect, test } from "bun:test";

import { isBannedImportLine } from "./check-no-node-fs.ts";

describe("isBannedImportLine", () => {
    test("flags a static named import of node:fs/promises", () => {
        expect(isBannedImportLine(`import { readFile } from "node:fs/promises";`)).toBe(true);
    });

    test("flags a dynamic import of node:path", () => {
        expect(isBannedImportLine(`const p = await import("node:path");`)).toBe(true);
    });

    test("does NOT flag a comment mentioning node:path", () => {
        expect(isBannedImportLine(`// node:path`)).toBe(false);
        expect(isBannedImportLine(`    // Mirrors path.basename without pulling node:path here.`)).toBe(false);
    });

    test("does NOT flag importing FileSystem from effect", () => {
        expect(isBannedImportLine(`import { FileSystem } from "effect";`)).toBe(false);
    });

    test("flags bare fs and path specifiers", () => {
        expect(isBannedImportLine(`import * as fs from "fs";`)).toBe(true);
        expect(isBannedImportLine(`import { join } from "path";`)).toBe(true);
    });

    test("flags side-effect and require forms", () => {
        expect(isBannedImportLine(`import "node:fs";`)).toBe(true);
        expect(isBannedImportLine(`const fs = require("node:fs");`)).toBe(true);
    });

    test("does NOT flag effect/platform helpers or unrelated identifiers", () => {
        expect(isBannedImportLine(`import { Path } from "@effect/platform";`)).toBe(false);
        expect(isBannedImportLine(`const base = path.basename(file);`)).toBe(false);
        expect(isBannedImportLine(`import { posixPath } from "@ax/lib/shared/path";`)).toBe(false);
    });
});
