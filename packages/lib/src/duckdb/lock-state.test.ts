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

    // Cross-review P3-5: pid 0 and negative pids are not process ids. Worse,
    // `process.kill(0, 0)` targets the CALLER'S PROCESS GROUP - it succeeds -
    // so a corrupt `"pid":0` payload read as a LIVE holder and wedged the
    // lock. Corrupt input must decode as corrupt.
    test("rejects a non-positive pid - it is corrupt, not a holder", () => {
        expect(decodeLockPayload('{"pid":0,"started_at":"2026-08-14T10:00:00.000Z"}')).toBeNull();
        expect(decodeLockPayload('{"pid":-5,"started_at":"2026-08-14T10:00:00.000Z"}')).toBeNull();
    });

    // Cross-review P1-4 / P2-3: the payload carries two more (optional)
    // fields now - a per-acquire token, so a stale handle can tell its own
    // lock from a successor's, and the holder's process start time, so a
    // reused pid is not mistaken for a live holder.
    test("round-trips the acquire token and the process start fingerprint", () => {
        const payload = {
            pid: 4242,
            started_at: "2026-08-14T10:00:00.000Z",
            token: "6f0b6f2c",
            proc_started_at: "Thu Aug 14 10:00:00 2026",
        };
        expect(decodeLockPayload(encodeLockPayload(payload))).toEqual(payload);
    });

    test("tolerates a payload without the optional fields", () => {
        const decoded = decodeLockPayload('{"pid":9,"started_at":"2026-08-14T10:00:00.000Z"}');
        expect(decoded?.pid).toBe(9);
        expect(decoded?.token).toBeUndefined();
        expect(decoded?.proc_started_at).toBeUndefined();
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
