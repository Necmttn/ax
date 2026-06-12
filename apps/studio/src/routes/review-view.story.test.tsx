import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { sampleNarration, sampleNarrationTurns } from "./narration-sample.ts";
import { ReviewView } from "./review-view.tsx";

describe("ReviewView as the Story surface", () => {
    const html = renderToStaticMarkup(
        <ReviewView
            data={{ turns: sampleNarrationTurns }}
            narration={sampleNarration}
            onOpenTranscript={() => {}}
        />,
    );

    test("keeps the review grounding: tree, change story, why lane", () => {
        // Default selection is the first written file - files-touched.ts.
        expect(html).toContain("files-touched.ts");
        expect(html).toContain("why this exists");
        expect(html).toContain("turns touching this file");
    });

    test("leads the why lane with the narration stops for the selected file", () => {
        expect(html).toContain("Fold tool calls into a files-touched tree");
        expect(html).toContain("Call counts become a char diffstat");
        // The correction quote is the evidence the PR never shows.
        expect(html).toContain("counts tell me nothing about the size of the change");
    });

    test("captions center-pane hunks with narration labels", () => {
        expect(html).toContain("The tool-to-path map that decides which calls count as file activity");
        expect(html).toContain("FileTouch carries the diffstat the correction asked for");
    });

    test("shows the intent strip and session-level context", () => {
        expect(html).toContain(sampleNarration.title);
        expect(html).toContain("session context");
        expect(html).toContain("Verification under a hostile hook");
    });

    test("without a narration it stays the plain review surface", () => {
        const plain = renderToStaticMarkup(
            <ReviewView data={{ turns: sampleNarrationTurns }} onOpenTranscript={() => {}} />,
        );
        expect(plain).toContain("why - turns touching this file");
        expect(plain).not.toContain("why this exists");
        expect(plain).not.toContain(sampleNarration.title);
    });
});
