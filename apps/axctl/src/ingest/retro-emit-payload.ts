/**
 * retro-emit-payload: the decoded shape of an `ax retro emit --from-file` JSON,
 * including the proposals a reviewer wants to file from that session (#742).
 *
 * The gap this closes. A manual retro used to be a dead end: `ax retro emit`
 * stored `{tried, worked, failed, next}` and `ax retro list` displayed it, but
 * nothing consumed it. The only retro -> proposal path is the
 * `derive-retro-proposals` stage, which parses the MACHINE-emitted shapes out of
 * `retro.failed` (`<Tool> failed ×<N>`, correction counts, friction kinds) and
 * needs a cluster across >=2 sessions. A human/agent reviewer writing prose
 * matches none of that, and `next` - the field that literally holds "what to try
 * next" - was never read by anything. A reviewer could spend a full session per
 * retro and produce zero triageable proposals.
 *
 * So a reviewer now files proposals DIRECTLY, in the same payload, through the
 * exact schema `ax improve propose` validates (`ProposeInputSchema`) - no second
 * format to learn, no mining heuristic to misfire, and a proposal is either
 * well-formed or a loud decode error.
 *
 * Decoding is strict on purpose: an unparseable `proposals` entry must fail the
 * emit, not silently drop the finding, because a silently-dropped proposal is
 * exactly the bug being fixed.
 */

import { Schema } from "effect";
import { ProposeInputSchema } from "../improve/propose.ts";

/**
 * `{tried, worked?, failed?, next?, proposals?}` - the file `ax retro emit
 * --from-file` reads. `tried` stays the one required field (unchanged), and
 * every proposal entry is a full `ax improve propose` payload.
 */
export const RetroEmitPayloadSchema = Schema.Struct({
    tried: Schema.String,
    worked: Schema.optional(Schema.String),
    failed: Schema.optional(Schema.String),
    next: Schema.optional(Schema.String),
    proposals: Schema.optional(Schema.Array(ProposeInputSchema)),
});

export type RetroEmitPayload = typeof RetroEmitPayloadSchema.Type;

export const decodeRetroEmitPayload = (raw: unknown) =>
    Schema.decodeUnknownEffect(RetroEmitPayloadSchema)(raw);

/**
 * Does this retro describe a problem but file nothing about it?
 *
 * `failed`/`next` are where reviewers put the durable findings, so substantive
 * text there plus an empty `proposals` is the open-loop shape the reporter hit:
 * work stored, nothing triageable. The emit still succeeds - a narrative-only
 * retro is legitimate - but the CLI says the loop is open rather than letting
 * the reviewer assume it closed.
 *
 * The threshold is deliberately crude (any non-trivial text). A precise
 * "is this a finding" classifier would be a second thing to get wrong; the
 * point is to prompt the human, not to judge them.
 */
export const MIN_SUBSTANTIVE_FINDING_CHARS = 40;

export const hasUnfiledFindings = (payload: RetroEmitPayload): boolean => {
    if ((payload.proposals?.length ?? 0) > 0) return false;
    const substantive = (text: string | undefined): boolean =>
        (text ?? "").trim().length >= MIN_SUBSTANTIVE_FINDING_CHARS;
    return substantive(payload.failed) || substantive(payload.next);
};
