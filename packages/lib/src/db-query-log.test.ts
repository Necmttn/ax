import { describe, expect, test } from "bun:test";
import { resolveQueryLogPath } from "./db.ts";

describe("resolveQueryLogPath", () => {
    test("routes a bare numeric value outside the current working directory", () => {
        const cwd = "/workspace/ax";
        const path = resolveQueryLogPath("1", "/home/user/.local/share/ax", cwd);

        expect(path).toBe("/home/user/.local/share/ax/db-query-1.querylog");
        expect(path).not.toBe(`${cwd}/1`);
    });

    test("preserves an absolute path", () => {
        expect(resolveQueryLogPath("/tmp/x.log", "/data/ax", "/workspace/ax"))
            .toBe("/tmp/x.log");
    });

    test("preserves an explicit dotted relative path", () => {
        expect(resolveQueryLogPath("./logs/x.log", "/data/ax", "/workspace/ax"))
            .toBe("./logs/x.log");
    });
});
