import { describe, expect, test } from "bun:test";
import type { FileTouch } from "./files-touched.ts";
import {
    buildNarrationReviewIndex,
    fileMatchesTouch,
    groupsForTouch,
    hunkLabelFor,
} from "./narration-review.ts";
import { sampleNarration } from "./narration-sample.ts";

const touch = (absPath: string, path: string): FileTouch => ({
    path,
    absPath,
    reads: 0,
    writes: 1,
    errors: 0,
    charsAdded: 10,
    charsRemoved: 2,
    firstSeq: 1,
    lastSeq: 20,
    status: "modified",
});

const filesTouchedTouch = touch(
    "/Users/necmttn/Projects/ax/apps/studio/src/routes/files-touched.ts",
    "apps/studio/src/routes/files-touched.ts",
);

describe("buildNarrationReviewIndex", () => {
    const index = buildNarrationReviewIndex(sampleNarration);

    test("groups stops under every file their hunks anchor", () => {
        const groups = index.byFile.get("apps/studio/src/routes/files-touched.ts");
        expect(groups).toBeDefined();
        // Stops 0 (tree fold) and 1 (diffstat correction) both hunk this file.
        expect(groups!.map((g) => g.stopIndex)).toEqual([0, 1]);
        expect(groups![0]!.title).toBe("Fold tool calls into a files-touched tree");
        expect(groups![1]!.gist).toContain("diffstat");
    });

    test("why groups carry every anchor except the hunks themselves", () => {
        const groups = index.byFile.get("apps/studio/src/routes/files-touched.ts")!;
        const kinds = groups[1]!.anchors.map((a) => a.kind);
        expect(kinds).toContain("correction");
        expect(kinds).not.toContain("file_hunk");
    });

    test("stops without file hunks land in sessionGroups", () => {
        const titles = index.sessionGroups.map((g) => g.title);
        expect(titles).toContain("The three-pane review view");
        expect(titles).toContain("Verification under a hostile hook");
        // File-anchored stops must NOT leak into the session bucket.
        expect(titles).not.toContain("Call counts become a char diffstat");
    });

    test("collects all file_hunk anchors for center-pane labeling", () => {
        expect(index.hunks.length).toBe(3);
        expect(index.hunks.every((h) => h.kind === "file_hunk")).toBe(true);
    });
});

describe("fileMatchesTouch", () => {
    test("matches a repo-relative narration path against the absolute touch path", () => {
        expect(fileMatchesTouch("apps/studio/src/routes/files-touched.ts", filesTouchedTouch)).toBe(true);
    });

    test("matches when the narration path equals the touch display path", () => {
        const t = touch("/repo/src/a.ts", "src/a.ts");
        expect(fileMatchesTouch("src/a.ts", t)).toBe(true);
    });

    test("rejects a same-suffix different file", () => {
        // "touched.ts" must not match "files-touched.ts" - segment boundary.
        const t = touch("/repo/files-touched.ts", "files-touched.ts");
        expect(fileMatchesTouch("touched.ts", t)).toBe(false);
    });

    test("rejects an unrelated file", () => {
        expect(fileMatchesTouch("apps/studio/src/routes/review-view.tsx", filesTouchedTouch)).toBe(false);
    });
});

describe("groupsForTouch", () => {
    const index = buildNarrationReviewIndex(sampleNarration);

    test("resolves the narration groups for a touch via path suffix match", () => {
        const groups = groupsForTouch(index, filesTouchedTouch);
        expect(groups.map((g) => g.stopIndex)).toEqual([0, 1]);
    });

    test("returns empty for a file the narration never mentions", () => {
        const t = touch("/repo/src/unrelated.ts", "src/unrelated.ts");
        expect(groupsForTouch(index, t)).toEqual([]);
    });
});

describe("hunkLabelFor", () => {
    const index = buildNarrationReviewIndex(sampleNarration);

    test("labels a story event whose old/new text matches a narration hunk verbatim", () => {
        const anchor = sampleNarration.stops[1]!.anchors.find((a) => a.kind === "file_hunk")!;
        const label = hunkLabelFor(index, filesTouchedTouch, {
            turnSeq: 999, // wrong seq on purpose - text match must win
            oldString: anchor.kind === "file_hunk" ? anchor.old_text : null,
            newString: anchor.kind === "file_hunk" ? anchor.new_text : null,
        });
        expect(label).toBe("FileTouch carries the diffstat the correction asked for");
    });

    test("falls back to turn_seq when the text drifted", () => {
        const label = hunkLabelFor(index, filesTouchedTouch, {
            turnSeq: 10,
            oldString: "drifted",
            newString: "drifted more",
        });
        expect(label).toBe("FileTouch carries the diffstat the correction asked for");
    });

    test("returns null when nothing matches", () => {
        const label = hunkLabelFor(index, filesTouchedTouch, {
            turnSeq: 999,
            oldString: "x",
            newString: "y",
        });
        expect(label).toBeNull();
    });
});
