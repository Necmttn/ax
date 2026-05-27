import { describe, expect, test } from "bun:test";
import { parseInlineMarkers, type InlineMarker } from "./markers.ts";

describe("parseInlineMarkers", () => {
    test("returns empty array for content with no markers", () => {
        expect(parseInlineMarkers("hello world")).toEqual([]);
    });

    test("extracts a single paired marker", () => {
        const input = `prefix <!--ax:e7f3-->body<!--/ax:e7f3--> suffix`;
        const out = parseInlineMarkers(input);
        expect(out).toEqual([
            { id: "e7f3", body: "body", openIndex: 7, closeIndex: 40 } as InlineMarker,
        ]);
    });

    test("extracts multiline body", () => {
        const input = `<!--ax:9a21-->\n- one\n- two\n<!--/ax:9a21-->`;
        const out = parseInlineMarkers(input);
        expect(out).toHaveLength(1);
        expect(out[0]!.id).toBe("9a21");
        expect(out[0]!.body).toBe("\n- one\n- two\n");
    });

    test("extracts multiple markers with different ids", () => {
        const input = `<!--ax:aa-->one<!--/ax:aa--> mid <!--ax:bb-->two<!--/ax:bb-->`;
        const out = parseInlineMarkers(input);
        expect(out.map((m) => m.id)).toEqual(["aa", "bb"]);
    });

    test("reports unmatched open as error", () => {
        const input = `<!--ax:e7f3-->dangling`;
        expect(() => parseInlineMarkers(input)).toThrow(/unmatched open/i);
    });

    test("reports duplicate id within one document as error", () => {
        const input = `<!--ax:aa-->one<!--/ax:aa--> <!--ax:aa-->two<!--/ax:aa-->`;
        expect(() => parseInlineMarkers(input)).toThrow(/duplicate id/i);
    });
});
