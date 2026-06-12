import { describe, expect, test } from "bun:test";
import { decodeQuotaSnapshot, toQuotaSnapshot } from "./schema.ts";

/** Live response shape captured from api.anthropic.com/api/oauth/usage (2026-06-12). */
const LIVE_PAYLOAD = {
    five_hour: { utilization: 88.0, resets_at: "2026-06-12T15:30:00.459756+00:00" },
    seven_day: { utilization: 51.0, resets_at: "2026-06-12T21:00:00.459780+00:00" },
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 4.0, resets_at: "2026-06-12T21:00:00.459791+00:00" },
    // Unknown experiment fields the endpoint ships today - must be ignored.
    seven_day_cowork: null,
    tangelo: null,
    iguana_necktie: null,
    extra_usage: {
        is_enabled: false,
        monthly_limit: null,
        used_credits: null,
        utilization: null,
        currency: null,
        disabled_reason: null,
    },
};

const FETCHED_AT = "2026-06-12T12:00:00.000Z";

describe("toQuotaSnapshot", () => {
    test("decodes the live payload shape", () => {
        const snapshot = toQuotaSnapshot(LIVE_PAYLOAD, FETCHED_AT);
        expect(snapshot).not.toBeNull();
        expect(snapshot?.five_hour).toEqual({
            utilization: 88.0,
            resets_at: "2026-06-12T15:30:00.459756+00:00",
        });
        expect(snapshot?.seven_day?.utilization).toBe(51.0);
        expect(snapshot?.seven_day_opus).toBeNull();
        expect(snapshot?.seven_day_sonnet?.utilization).toBe(4.0);
        expect(snapshot?.extra_usage).toEqual({
            is_enabled: false,
            utilization: null,
            used_credits: null,
            monthly_limit: null,
        });
        expect(snapshot?.fetched_at).toBe(FETCHED_AT);
    });

    test("tolerates missing optional windows", () => {
        const snapshot = toQuotaSnapshot(
            { five_hour: { utilization: 10, resets_at: FETCHED_AT } },
            FETCHED_AT,
        );
        expect(snapshot?.five_hour?.utilization).toBe(10);
        expect(snapshot?.seven_day).toBeNull();
        expect(snapshot?.extra_usage).toBeNull();
    });

    test("rejects garbage", () => {
        expect(toQuotaSnapshot("nope", FETCHED_AT)).toBeNull();
        expect(toQuotaSnapshot(null, FETCHED_AT)).toBeNull();
        expect(
            toQuotaSnapshot({ five_hour: { utilization: "88", resets_at: 5 } }, FETCHED_AT),
        ).toBeNull();
    });
});

describe("decodeQuotaSnapshot", () => {
    test("round-trips a snapshot through JSON (cache format)", () => {
        const snapshot = toQuotaSnapshot(LIVE_PAYLOAD, FETCHED_AT);
        const reread = decodeQuotaSnapshot(JSON.parse(JSON.stringify(snapshot)));
        expect(reread).toEqual(snapshot);
    });

    test("rejects wrong version / shape", () => {
        expect(decodeQuotaSnapshot({ v: 2, fetched_at: FETCHED_AT })).toBeNull();
        expect(decodeQuotaSnapshot({})).toBeNull();
    });
});
