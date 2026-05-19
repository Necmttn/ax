import { describe, expect, test } from "bun:test";
import { spliceHookFires, type RenderItem } from "./hook-fire-splice.ts";
import type { HookFireDto, InspectTurnDto } from "./dashboard-types.ts";

const turn = (seq: number, ts: string | null): InspectTurnDto => ({
    seq,
    role: "assistant",
    semantic_role: "assistant_text",
    ts,
    char_count: 10,
    spans: [{ kind: "assistant_text", text: "hi" }],
});

const hf = (idx: number, ts: string, extras: Partial<HookFireDto> = {}): HookFireDto => ({
    idx,
    ts,
    event: "pre-edit",
    file_path: "/tmp/x.ts",
    inject: false,
    reason: "no_files",
    latency_ms: 12,
    injected_titles: [],
    ...extras,
});

const kinds = (items: ReadonlyArray<RenderItem>): string =>
    items.map((i) => i.kind === "turn" ? `T${i.turn.seq}` : `H${i.hook.idx}`).join(",");

describe("spliceHookFires", () => {
    test("empty hook_fires returns turns unchanged", () => {
        const turns = [turn(0, "2026-05-15T10:00:00Z"), turn(1, "2026-05-15T10:00:01Z")];
        expect(kinds(spliceHookFires(turns, []))).toBe("T0,T1");
    });

    test("empty turns plus non-empty hook_fires emits all hook_fires", () => {
        const out = spliceHookFires([], [hf(0, "2026-05-15T10:00:00Z"), hf(1, "2026-05-15T10:00:01Z")]);
        expect(kinds(out)).toBe("H0,H1");
    });

    test("hook_fire placed immediately before nearest following turn", () => {
        const turns = [
            turn(0, "2026-05-15T10:00:00Z"),
            turn(1, "2026-05-15T10:00:05Z"),
            turn(2, "2026-05-15T10:00:10Z"),
        ];
        const hooks = [hf(0, "2026-05-15T10:00:02Z")];
        expect(kinds(spliceHookFires(turns, hooks))).toBe("T0,H0,T1,T2");
    });

    test("hook_fire before first turn lands at start", () => {
        const turns = [turn(0, "2026-05-15T10:00:05Z"), turn(1, "2026-05-15T10:00:10Z")];
        const hooks = [hf(0, "2026-05-15T10:00:00Z")];
        expect(kinds(spliceHookFires(turns, hooks))).toBe("H0,T0,T1");
    });

    test("hook_fire after last turn lands at end as orphan", () => {
        const turns = [turn(0, "2026-05-15T10:00:00Z"), turn(1, "2026-05-15T10:00:05Z")];
        const hooks = [hf(0, "2026-05-15T10:00:10Z")];
        expect(kinds(spliceHookFires(turns, hooks))).toBe("T0,T1,H0");
    });

    test("multiple hook_fires between same two turns preserve ts order", () => {
        const turns = [turn(0, "2026-05-15T10:00:00Z"), turn(1, "2026-05-15T10:00:10Z")];
        const hooks = [
            hf(1, "2026-05-15T10:00:05Z"),
            hf(0, "2026-05-15T10:00:03Z"),
            hf(2, "2026-05-15T10:00:07Z"),
        ];
        expect(kinds(spliceHookFires(turns, hooks))).toBe("T0,H0,H1,H2,T1");
    });

    test("hook_fire ts equal to turn ts is placed BEFORE that turn", () => {
        const turns = [turn(0, "2026-05-15T10:00:00Z"), turn(1, "2026-05-15T10:00:05Z")];
        const hooks = [hf(0, "2026-05-15T10:00:05Z")];
        expect(kinds(spliceHookFires(turns, hooks))).toBe("T0,H0,T1");
    });

    test("hook_fire with no ts is dropped", () => {
        const turns = [turn(0, "2026-05-15T10:00:00Z")];
        const hooks = [hf(0, ""), hf(1, "2026-05-15T10:00:05Z")];
        expect(kinds(spliceHookFires(turns, hooks))).toBe("T0,H1");
    });

    test("turn with null ts does not gate hook splicing", () => {
        const turns = [
            turn(0, "2026-05-15T10:00:00Z"),
            turn(1, null),
            turn(2, "2026-05-15T10:00:10Z"),
        ];
        const hooks = [hf(0, "2026-05-15T10:00:07Z")];
        expect(kinds(spliceHookFires(turns, hooks))).toBe("T0,T1,H0,T2");
    });
});
