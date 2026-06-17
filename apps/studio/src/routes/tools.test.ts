import { describe, expect, test } from "bun:test";
import { toolFailuresRefreshUi } from "./tools.tsx";

describe("toolFailuresRefreshUi", () => {
    test("background query fetching does not lock the manual refresh button", () => {
        const state = toolFailuresRefreshUi({
            manualRefreshing: false,
            queryIsFetching: true,
            queryIsLoading: false,
        });

        expect(state.disabled).toBe(false);
        expect(state.label).toBe("Refresh");
        expect(state.tableOpacity).toBe(1);
    });

    test("manual refresh owns the disabled state", () => {
        const state = toolFailuresRefreshUi({
            manualRefreshing: true,
            queryIsFetching: true,
            queryIsLoading: false,
        });

        expect(state.disabled).toBe(true);
        expect(state.label).toBe("Refreshing…");
        expect(state.tableOpacity).toBe(0.6);
    });
});
