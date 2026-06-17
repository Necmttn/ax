import { describe, expect, test } from "bun:test";
import { toolFailuresRefreshUi } from "./tools.tsx";

describe("toolFailuresRefreshUi", () => {
    test("idle (no manual refresh) leaves the button enabled", () => {
        // Background React Query fetching is intentionally not an input - the
        // toolbar must not lock while ingest invalidations refetch in the bg.
        const state = toolFailuresRefreshUi({ manualRefreshing: false });

        expect(state.disabled).toBe(false);
        expect(state.label).toBe("Refresh");
        expect(state.tableOpacity).toBe(1);
    });

    test("manual refresh owns the disabled state", () => {
        const state = toolFailuresRefreshUi({ manualRefreshing: true });

        expect(state.disabled).toBe(true);
        expect(state.label).toBe("Refreshing…");
        expect(state.tableOpacity).toBe(0.6);
    });
});
