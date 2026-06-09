import type { InspectTurnDto } from "@ax/lib/shared/dashboard-types";
import { extractImagePaths, isPureImageAttachment } from "./turn-images.ts";

export interface ImagePairing {
    /** turn `seq` → the image paths to render on that turn: its OWN
     *  `[Image: source: …]` paths plus any folded in from the consecutive
     *  pure-attachment turns directly following it. */
    readonly imagePathsByTurn: Map<number, string[]>;
    /** `seq`s of pure-attachment turns whose image was folded into a preceding
     *  anchor turn's card, so the caller can skip rendering them standalone. */
    readonly consumedSeqs: Set<number>;
}

/**
 * Fold "pure image attachment" turns into the message that references them.
 *
 * Claude Code splits a pasted screenshot across two adjacent turns: the user's
 * actual message (a `[Image #N]` marker with no source path) and a standalone
 * follow-on turn whose text is essentially just `[Image: source: /abs.png]`.
 * Rendered as-is they read as two disconnected turns with the image floating
 * below the prose that mentions it.
 *
 * This pass walks the turns and, for each turn that is NOT itself a pure
 * attachment (the "anchor"), gathers that turn's own image paths plus the image
 * paths of every IMMEDIATELY-FOLLOWING consecutive pure-attachment turn, maps
 * them all to the anchor's seq, and marks the folded attachment turns consumed.
 *
 * Conservative by design:
 *   - Only consecutive pure-attachment turns directly after an anchor are
 *     consumed; the run stops at the first non-pure turn.
 *   - A pure-attachment turn with no eligible preceding anchor (it is the very
 *     first turn, or is only preceded by already-consumed attachments) is left
 *     standalone (NOT consumed) so its image still renders on its own - we
 *     never drop an image we can't confidently attribute.
 */
export function pairImageAttachments(
    turns: ReadonlyArray<InspectTurnDto>,
): ImagePairing {
    const imagePathsByTurn = new Map<number, string[]>();
    const consumedSeqs = new Set<number>();

    for (let i = 0; i < turns.length; i++) {
        const turn = turns[i];
        if (isPureImageAttachment(turn.raw_text ?? "")) continue;

        // Anchor turn: start with its own renderable image paths.
        const paths = extractImagePaths(turn.raw_text ?? "");

        // Fold the consecutive run of pure-attachment turns immediately after.
        let cursor = i + 1;
        while (cursor < turns.length && isPureImageAttachment(turns[cursor].raw_text ?? "")) {
            paths.push(...extractImagePaths(turns[cursor].raw_text ?? ""));
            consumedSeqs.add(turns[cursor].seq);
            cursor++;
        }

        if (paths.length > 0) imagePathsByTurn.set(turn.seq, paths);
    }

    return { imagePathsByTurn, consumedSeqs };
}
