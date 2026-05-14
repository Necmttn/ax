import { describe, expect, test } from "bun:test";
import type { SpawnSyncReturns } from "node:child_process";
import { candidatePorts, pickFreePort, probePort } from "./port.ts";

const lsofResult = (stdout: string, status = 0): SpawnSyncReturns<string> =>
    ({
        pid: 0,
        output: ["", stdout, ""] as unknown as string[],
        stdout,
        stderr: "",
        status,
        signal: null,
    }) as unknown as SpawnSyncReturns<string>;

describe("probePort", () => {
    test("returns listening=false on missing/empty lsof output", () => {
        const r = probePort(8521, () => lsofResult("", 1));
        expect(r.listening).toBe(false);
        expect(r.holder).toBeNull();
    });

    test("parses pid + command from lsof -F pcL output", () => {
        const fixture = ["p1234", "cmy-daemon", "Lroot"].join("\n");
        const r = probePort(8521, () => lsofResult(fixture, 0));
        expect(r.listening).toBe(true);
        expect(r.holder).toEqual({ pid: 1234, command: "my-daemon" });
    });
});

describe("pickFreePort", () => {
    test("picks first free candidate", () => {
        const busy = new Set([8521, 8522]);
        const runner = (port: number): SpawnSyncReturns<string> =>
            busy.has(port)
                ? lsofResult(`p${port}\ncother\n`, 0)
                : lsofResult("", 1);
        const pick = pickFreePort([8521, 8522, 8523], runner);
        expect(pick.chosen).toBe(8523);
        expect(pick.attempted.map((a) => a.port)).toEqual([8521, 8522, 8523]);
        expect(pick.attempted[0]?.listening).toBe(true);
    });

    test("throws when every candidate is bound", () => {
        const runner = (port: number): SpawnSyncReturns<string> =>
            lsofResult(`p${port}\ncother\n`, 0);
        expect(() => pickFreePort([1, 2, 3], runner)).toThrow("no free port");
    });
});

describe("candidatePorts", () => {
    test("returns N consecutive ports starting at preferred", () => {
        expect(candidatePorts(8521, 3)).toEqual([8521, 8522, 8523]);
    });
});
