// packages/lib/src/sqlite/sidecar-path.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { sidecarPath } from "./sidecar.ts";

const original = process.env.AX_SIDECAR_PATH;

afterEach(() => {
    if (original === undefined) delete process.env.AX_SIDECAR_PATH;
    else process.env.AX_SIDECAR_PATH = original;
});

describe("sidecarPath", () => {
    test("defaults to ~/.ax/judgment.sqlite - NOT under the cache directory", () => {
        delete process.env.AX_SIDECAR_PATH;
        const path = sidecarPath();
        expect(path).toBe(`${homedir()}/.ax/judgment.sqlite`);
        // The placement is the contract: `~/.ax/cache/` is the directory a user
        // (or `ax doctor`) may delete to force a rebuild, and this file is the
        // one thing in ax that no rebuild can reproduce.
        expect(path).not.toContain("/.ax/cache/");
    });

    test("honours AX_SIDECAR_PATH", () => {
        process.env.AX_SIDECAR_PATH = "/tmp/elsewhere/judgment.sqlite";
        expect(sidecarPath()).toBe("/tmp/elsewhere/judgment.sqlite");
    });

    test("ignores a blank override rather than resolving to an empty path", () => {
        process.env.AX_SIDECAR_PATH = "   ";
        expect(sidecarPath()).toBe(`${homedir()}/.ax/judgment.sqlite`);
    });
});
