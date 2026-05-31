import { describe, expect, test } from "bun:test";
import { rawBlockTextStyle } from "./session-inspect.tsx";

const tone = {
    bg: "#fce7f3",
    fg: "#9d174d",
    bar: "#ec4899",
    label: "plugins",
};

describe("rawBlockTextStyle", () => {
    test("does not flood-fill selected transcript blocks", () => {
        const style = rawBlockTextStyle({ tone, active: true, hovered: false, mismatch: false });

        expect(style.background).toBe("transparent");
        expect(style.outline).toBe("none");
        expect(style.borderBottom).toBe(`1px solid ${tone.bar}`);
        expect(style.boxShadow).toBe(`inset 0 -2px 0 ${tone.bar}`);
    });

    test("keeps hover and mismatch cues visible", () => {
        const hovered = rawBlockTextStyle({ tone, active: false, hovered: true, mismatch: false });
        const mismatch = rawBlockTextStyle({ tone, active: false, hovered: false, mismatch: true });

        expect(hovered.background).toBe(tone.bg);
        expect(hovered.borderBottom).toBe(`1px solid ${tone.bar}`);
        expect(mismatch.background).toBe("transparent");
        expect(mismatch.borderBottom).toBe("1px dotted #f97316");
    });
});
