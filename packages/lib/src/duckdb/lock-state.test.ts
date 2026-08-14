import { describe, expect, test } from "bun:test";
import { decideLock, decodeLockPayload, encodeLockPayload } from "./lock-state.ts";

const alive = () => true;
const dead = () => false;

describe("lock payload codec", () => {
    test("round-trips pid and started_at", () => {
        const payload = { pid: 4242, started_at: "2026-08-14T10:00:00.000Z" };
        expect(decodeLockPayload(encodeLockPayload(payload))).toEqual(payload);
    });

    test("rejects junk and partial payloads instead of guessing", () => {
        expect(decodeLockPayload("not json")).toBeNull();
        expect(decodeLockPayload("{}")).toBeNull();
        expect(decodeLockPayload('{"pid":"x","started_at":"y"}')).toBeNull();
    });
});

describe("decideLock", () => {
    test("no file means free", () => {
        expect(decideLock(null, alive, 1, false).kind).toBe("free");
    });

    test("a live foreign holder means held, and the holder comes back with it", () => {
        const text = encodeLockPayload({ pid: 999, started_at: "2026-08-14T10:00:00.000Z" });
        const decision = decideLock(text, alive, 1, false);
        expect(decision.kind).toBe("held");
        expect(decision.holder?.pid).toBe(999);
    });

    test("a dead holder means stale, so the next run can take over", () => {
        const text = encodeLockPayload({ pid: 999, started_at: "2026-08-14T10:00:00.000Z" });
        expect(decideLock(text, dead, 1, false).kind).toBe("stale");
    });

    test("an unreadable lock file is stale, not a permanent wedge", () => {
        expect(decideLock("garbage", alive, 1, false).kind).toBe("stale");
    });

    test("our own pid without selfHolds is stale - a leftover from a pid the OS reused, or a prior unreleased run", () => {
        const text = encodeLockPayload({ pid: 7, started_at: "2026-08-14T10:00:00.000Z" });
        expect(decideLock(text, alive, 7, false).kind).toBe("stale");
    });

    test("our own pid WITH selfHolds is held - a second in-process acquirer must not clobber the first", () => {
        const text = encodeLockPayload({ pid: 7, started_at: "2026-08-14T10:00:00.000Z" });
        const decision = decideLock(text, alive, 7, true);
        expect(decision.kind).toBe("held");
        expect(decision.holder?.pid).toBe(7);
    });

    test("selfHolds is ignored for a foreign pid - it only disambiguates our own pid", () => {
        const text = encodeLockPayload({ pid: 999, started_at: "2026-08-14T10:00:00.000Z" });
        expect(decideLock(text, alive, 1, true).kind).toBe("held");
        expect(decideLock(text, dead, 1, true).kind).toBe("stale");
    });
});
