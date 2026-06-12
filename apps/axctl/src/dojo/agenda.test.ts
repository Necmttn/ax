// apps/axctl/src/dojo/agenda.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import type { Surreal } from "surrealdb";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { assembleAgenda, collectAgendaItems } from "./agenda.ts";
import type { BudgetEnvelope, DojoItem } from "./schema.ts";

const budget: BudgetEnvelope = {
    has_surplus: true, spendable_pct: 20, binding_window: "five_hour",
    window_remaining_pct: 35, reserve_pct: 15,
    deadline: "2026-06-13T12:00:00.000Z", source: "quota",
};

const item = (id: string, kind: DojoItem["kind"]): DojoItem => ({
    id, kind, title: id, commands: ["true"], success: "done", cost_class: "s",
});

describe("assembleAgenda", () => {
    test("sorts by kind priority and stamps generated_at", () => {
        const agenda = assembleAgenda(
            budget,
            [item("e1", "experiment"), item("v1", "verdict_pending"), item("b1", "brief_unfilled")],
            { nowMs: Date.parse("2026-06-13T10:00:00.000Z"), spar: false },
        );
        expect(agenda.v).toBe(1);
        expect(agenda.generated_at).toBe("2026-06-13T10:00:00.000Z");
        expect(agenda.items.map((i) => i.id)).toEqual(["v1", "b1", "e1"]);
    });

    test("appends explore when otherwise empty", () => {
        const agenda = assembleAgenda(budget, [], { nowMs: 0, spar: false });
        expect(agenda.items).toHaveLength(1);
        expect(agenda.items[0]?.kind).toBe("explore");
    });

    test("spar included only when requested AND spendable >= 30", () => {
        const none = assembleAgenda(budget, [item("v1", "verdict_pending")], { nowMs: 0, spar: true });
        expect(none.items.some((i) => i.kind === "spar")).toBe(false); // spendable 20 < 30
        const fat = assembleAgenda(
            { ...budget, spendable_pct: 40 },
            [item("v1", "verdict_pending")],
            { nowMs: 0, spar: true },
        );
        expect(fat.items.some((i) => i.kind === "spar")).toBe(true);
    });
});

describe("collectAgendaItems", () => {
    // Every query returns one empty result set - an empty graph. fetchDispatches
    // destructures a 4-tuple, but each missing slot degrades to [] internally.
    const emptyClient: SurrealClientShape = {
        query: <T extends unknown[]>(_sql: string, _bindings?: Record<string, unknown>) =>
            Effect.succeed([[]] as unknown[] as T),
        upsert: () => Effect.void,
        relate: () => Effect.void,
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(""),
        raw: null as unknown as Surreal, // never touched by read-only agenda sources
    };
    const env = Layer.mergeAll(Layer.succeed(SurrealClient, emptyClient), BunFileSystem.layer);

    test("empty graph + missing task dir -> only the proposal-mint nudge", async () => {
        const base = mkdtempSync(join(tmpdir(), "ax-dojo-agenda-"));
        const items = await Effect.runPromise(
            collectAgendaItems({
                nowMs: Date.parse("2026-06-13T10:00:00.000Z"),
                days: 30,
                spar: false,
                taskDir: join(base, "does-not-exist"),
                routingTablePath: join(base, "missing-routing-table.json"),
            }).pipe(Effect.provide(env)),
        );
        // 0 open proposals < MINT_THRESHOLD, so the mint nudge is the lone item.
        expect(items.map((i) => i.kind)).toEqual(["proposal_mint"]);
    });
});
