/**
 * Narration → review-surface index. The Story tab is the Review view with a
 * why lane: files/diffs stay primary, and the narration's stops attach to the
 * files their `file_hunk` anchors touch. This module is the pure join - it
 * groups stops by file, buckets file-less stops as session-level context, and
 * resolves narration labels for the center pane's hunks.
 */

import type { FileStoryEvent, FileTouch } from "./files-touched.ts";
import type { FileHunkAnchor, NarrationAnchor, SessionNarration } from "./narration-types.ts";

/** One narration stop projected into the why lane: its non-hunk anchors
 *  (corrections, directions, failures, terms, snapshots) plus the headline.
 *  The hunks themselves render in the center pane, not here. */
export interface StoryWhyGroup {
    /** Index into narration.stops - keeps reading order stable. */
    readonly stopIndex: number;
    readonly title: string;
    readonly gist: string;
    readonly anchors: ReadonlyArray<NarrationAnchor>;
}

export interface NarrationReviewIndex {
    /** Stop groups keyed by the verbatim file path from each file_hunk anchor. */
    readonly byFile: ReadonlyMap<string, ReadonlyArray<StoryWhyGroup>>;
    /** Stops with no file_hunk anchor - session-level context (verification,
     *  direction-setting) shown regardless of the selected file. */
    readonly sessionGroups: ReadonlyArray<StoryWhyGroup>;
    /** Every file_hunk anchor, for labeling center-pane hunk cards. */
    readonly hunks: ReadonlyArray<FileHunkAnchor>;
}

export function buildNarrationReviewIndex(narration: SessionNarration): NarrationReviewIndex {
    const byFile = new Map<string, StoryWhyGroup[]>();
    const sessionGroups: StoryWhyGroup[] = [];
    const hunks: FileHunkAnchor[] = [];
    narration.stops.forEach((stop, stopIndex) => {
        const stopHunks = stop.anchors.filter((a): a is FileHunkAnchor => a.kind === "file_hunk");
        hunks.push(...stopHunks);
        const group: StoryWhyGroup = {
            stopIndex,
            title: stop.title,
            gist: stop.gist,
            anchors: stop.anchors.filter((a) => a.kind !== "file_hunk"),
        };
        if (stopHunks.length === 0) {
            sessionGroups.push(group);
            return;
        }
        for (const file of new Set(stopHunks.map((h) => h.file))) {
            const groups = byFile.get(file) ?? [];
            groups.push(group);
            byFile.set(file, groups);
        }
    });
    return { byFile, sessionGroups, hunks };
}

/** Narration paths are repo-relative; touches carry absolute + root-stripped
 *  paths. Match on whole path segments so "touched.ts" never claims
 *  "files-touched.ts". */
export function fileMatchesTouch(
    narrationFile: string,
    touch: Pick<FileTouch, "absPath" | "path">,
): boolean {
    return (
        touch.absPath === narrationFile ||
        touch.absPath.endsWith(`/${narrationFile}`) ||
        touch.path === narrationFile ||
        narrationFile.endsWith(`/${touch.path}`)
    );
}

/** The why-lane groups for one selected file, in stop order, deduped. */
export function groupsForTouch(
    index: NarrationReviewIndex,
    touch: Pick<FileTouch, "absPath" | "path">,
): StoryWhyGroup[] {
    const seen = new Set<number>();
    const out: StoryWhyGroup[] = [];
    for (const [file, groups] of index.byFile) {
        if (!fileMatchesTouch(file, touch)) continue;
        for (const group of groups) {
            if (seen.has(group.stopIndex)) continue;
            seen.add(group.stopIndex);
            out.push(group);
        }
    }
    return out.sort((a, b) => a.stopIndex - b.stopIndex);
}

/** Narration label for one center-pane story event. Verbatim old/new text
 *  match wins (anchors quote the tool calls); turn_seq is the fallback when
 *  the narration trimmed the fragment. */
export function hunkLabelFor(
    index: NarrationReviewIndex,
    touch: Pick<FileTouch, "absPath" | "path">,
    event: Pick<FileStoryEvent, "turnSeq" | "oldString" | "newString">,
): string | null {
    const candidates = index.hunks.filter((h) => fileMatchesTouch(h.file, touch));
    const exact = candidates.find(
        (h) => (h.old_text ?? null) === (event.oldString ?? null) &&
            (h.new_text ?? null) === (event.newString ?? null),
    );
    if (exact) return exact.label;
    const bySeq = candidates.find((h) => h.turn_seq !== undefined && h.turn_seq === event.turnSeq);
    return bySeq?.label ?? null;
}
