import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MissionControlContent } from "./mission-control.tsx";

describe("MissionControlContent", () => {
    test("loading state explains the cold wrapped-profile build", () => {
        const html = renderToStaticMarkup(
            <MissionControlContent data={null} isLoading error={null} />,
        );

        expect(html).toContain("building profile");
        expect(html).toContain("Cold graph scans can take about 20s");
    });

    test("error state is visible instead of a blank instrument", () => {
        const html = renderToStaticMarkup(
            <MissionControlContent data={null} isLoading={false} error={new Error("db down")} />,
        );

        expect(html).toContain("wrapped profile failed");
        expect(html).toContain("db down");
    });
});
