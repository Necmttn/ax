import { describe, expect, test } from "bun:test";
import type { InspectTurnDto, SessionInspectPayload } from "@ax/lib/shared/dashboard-types";
import { buildTranscriptRenderModel } from "./transcript.tsx";

const turn = (seq: number, partial: Partial<InspectTurnDto> = {}): InspectTurnDto => ({
    seq,
    role: "assistant",
    semantic_role: "assistant_text",
    ts: null,
    char_count: partial.raw_text?.length ?? 0,
    raw_text: partial.raw_text ?? "",
    spans: [{ kind: "assistant_text", text: partial.raw_text ?? "" }],
    token_usage: null,
    content: null,
    ...partial,
});

const payload = (turns: ReadonlyArray<InspectTurnDto>): SessionInspectPayload => ({
    session_id: "session:test",
    source_path: "fixture",
    project: null,
    cwd: null,
    total_chars: turns.reduce((sum, t) => sum + t.char_count, 0),
    totals_by_kind: {},
    token_usage: null,
    total_turns: turns.length,
    turn_window: { offset: 0, limit: turns.length },
    turns,
    parent_session: null,
    parent_nickname: null,
    children: [],
    hook_fires: [],
    total_hook_fires: 0,
});

describe("buildTranscriptRenderModel", () => {
    test("pairs tool results and image attachments once for a rendered turn window", () => {
        const data = payload([
            turn(1, {
                semantic_role: "tool_use",
                tool_calls: [{
                    seq: 1,
                    name: "Bash",
                    category: "sh",
                    input: null,
                    command: "echo ok",
                    output_excerpt: null,
                    has_error: false,
                    tokens: null,
                }],
            }),
            turn(2, { semantic_role: "tool_result", raw_text: "ok" }),
            turn(3, { raw_text: "look [Image #1]" }),
            turn(4, { raw_text: "[Image: source: /tmp/screenshot.png]" }),
        ]);

        const model = buildTranscriptRenderModel(data);

        expect(model.items.map((item) => item.kind === "turn" ? item.turn.seq : `hook:${item.hook.idx}`)).toEqual([1, 2, 3, 4]);
        expect(model.resultByCall.get("1:0")).toBe("ok");
        expect(model.consumedResultSeqs.has(2)).toBe(true);
        expect(model.imagePathsByTurn.get(3)).toEqual(["/tmp/screenshot.png"]);
        expect(model.consumedImageSeqs.has(4)).toBe(true);
    });
});
