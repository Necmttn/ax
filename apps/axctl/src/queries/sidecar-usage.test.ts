import { describe, expect, test } from "bun:test";
import { SIDECAR_USAGE_SUMMARY_SQL } from "./sidecar-usage.ts";

describe("sidecar usage queries", () => {
    test("reads sidecar artifacts and usage edges", () => {
        expect(SIDECAR_USAGE_SUMMARY_SQL).toContain("FROM claude_sidecar_artifact");
        expect(SIDECAR_USAGE_SUMMARY_SQL).toContain("FROM used_sidecar_artifact");
        expect(SIDECAR_USAGE_SUMMARY_SQL).toContain("GROUP BY action, sidecar_kind");
    });
});
