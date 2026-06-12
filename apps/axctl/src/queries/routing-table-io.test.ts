import { describe, expect, it } from "bun:test";
import { Effect, FileSystem, Layer, Path } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";

import { ROUTING_CLASSES } from "./dispatch-analytics.ts";
import {
    mergeRoutingTables,
    loadStoredRoutingTable,
    saveStoredRoutingTable,
    loadEffectiveRoutingTable,
    appendUserClasses,
    type LoadedRoutingTable,
    type StoredRoutingTable,
    type StoredRoutingClass,
} from "./routing-table-io.ts";

const fsLayers = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);
const run = <A, E>(eff: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    Effect.runPromise(eff.pipe(Effect.provide(fsLayers)));

const userClass: StoredRoutingClass = {
    id: "my-mined-class",
    pattern: "^summarize",
    flags: "i",
    suggest: "haiku",
    reason: "mined from my history",
    origin: "user",
};

describe("mergeRoutingTables", () => {
    it("tags all default classes with origin: default", () => {
        const merged = mergeRoutingTables(ROUTING_CLASSES, null);
        expect(merged.classes.length).toBe(ROUTING_CLASSES.classes.length);
        for (const c of merged.classes) expect(c.origin).toBe("default");
    });

    it("preserves user classes from the existing file", () => {
        const existing: StoredRoutingTable = {
            version: 1,
            classes: [
                { ...ROUTING_CLASSES.classes[0]!, origin: "default" },
                userClass,
            ],
            agentTypes: { ...ROUTING_CLASSES.agentTypes },
        };
        const merged = mergeRoutingTables(ROUTING_CLASSES, existing);
        const ids = merged.classes.map((c) => c.id);
        expect(ids).toContain("my-mined-class");
        // defaults refresh: every current default present exactly once
        for (const d of ROUTING_CLASSES.classes) {
            expect(ids.filter((i) => i === d.id)).toHaveLength(1);
        }
    });

    it("drops stale default classes but never user classes", () => {
        const existing: StoredRoutingTable = {
            version: 1,
            classes: [
                { id: "removed-default", pattern: "^x", flags: "i", suggest: "sonnet", reason: "old", origin: "default" },
                userClass,
            ],
            agentTypes: {},
        };
        const merged = mergeRoutingTables(ROUTING_CLASSES, existing);
        const ids = merged.classes.map((c) => c.id);
        expect(ids).not.toContain("removed-default");
        expect(ids).toContain("my-mined-class");
    });

    it("user class shadowed by a new default of the same id defers to the default", () => {
        const existing: StoredRoutingTable = {
            version: 1,
            classes: [{ ...userClass, id: "spec-review" }],
            agentTypes: {},
        };
        const merged = mergeRoutingTables(ROUTING_CLASSES, existing);
        const specReview = merged.classes.filter((c) => c.id === "spec-review");
        expect(specReview).toHaveLength(1);
        expect(specReview[0]!.origin).toBe("default");
    });

    it("refreshes agentTypes from defaults but keeps user-added keys", () => {
        const existing: StoredRoutingTable = {
            version: 1,
            classes: [],
            // stale stored copy: codebase-analyzer was edited away from the
            // current default; my-custom-agent is a user addition
            agentTypes: { "codebase-analyzer": "haiku", "my-custom-agent": "haiku" },
        };
        const merged = mergeRoutingTables(ROUTING_CLASSES, existing);
        expect(merged.agentTypes["codebase-analyzer"]).toBe("sonnet");
        expect(merged.agentTypes["my-custom-agent"]).toBe("haiku");
    });

    it("migrates legacy origin-less rows as user classes", () => {
        // Today's compile-routing output has NO origin tags; hand-added rows
        // may lack them too. They must survive the merge tagged origin: user.
        const existing: LoadedRoutingTable = {
            version: 1,
            classes: [
                { id: "hand-added", pattern: "^x", flags: "i", suggest: "haiku", reason: "mine" },
            ],
            agentTypes: {},
        };
        const merged = mergeRoutingTables(ROUTING_CLASSES, existing);
        const row = merged.classes.find((c) => c.id === "hand-added");
        expect(row).toBeDefined();
        expect(row!.origin).toBe("user");
    });
});

describe("appendUserClasses", () => {
    it("appends with origin user and dedupes by id", () => {
        const base = mergeRoutingTables(ROUTING_CLASSES, null);
        const out = appendUserClasses(base, [userClass, userClass]);
        expect(out.classes.filter((c) => c.id === "my-mined-class")).toHaveLength(1);
        expect(out.classes.at(-1)!.origin).toBe("user");
    });
});

describe("load/save round-trip", () => {
    it("save then load returns the same table; missing file loads null", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-routing-io-"));
        const p = join(dir, "routing-table.json");
        const table = appendUserClasses(mergeRoutingTables(ROUTING_CLASSES, null), [userClass]);
        await run(saveStoredRoutingTable(p, table));
        const loaded = await run(loadStoredRoutingTable(p));
        expect(loaded).toEqual(table);
        const missing = await run(loadStoredRoutingTable(join(dir, "nope.json")));
        expect(missing).toBeNull();
    });

    it("normalizes a hand-edited file: missing agentTypes becomes {}, malformed rows dropped", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-routing-io-"));
        const p = join(dir, "hand-edited.json");
        const validRow = {
            id: "my-mined-class",
            pattern: "^summarize",
            flags: "i",
            suggest: "haiku",
            reason: "mined from my history",
        };
        writeFileSync(p, JSON.stringify({ version: 1, classes: [validRow, { id: 42 }] }));
        const loaded = await run(loadStoredRoutingTable(p));
        expect(loaded).not.toBeNull();
        expect(loaded!.agentTypes).toEqual({});
        expect(loaded!.classes).toHaveLength(1);
        expect(loaded!.classes[0]!.id).toBe("my-mined-class");
    });

    it("loadEffectiveRoutingTable falls back to defaults when file missing or corrupt", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-routing-io-"));
        const corrupt = join(dir, "bad.json");
        writeFileSync(corrupt, "{not json");
        const eff1 = await run(loadEffectiveRoutingTable(corrupt));
        expect(eff1.classes.map((c) => c.id)).toEqual(ROUTING_CLASSES.classes.map((c) => c.id));
        const eff2 = await run(loadEffectiveRoutingTable(join(dir, "absent.json")));
        expect(eff2.classes.length).toBe(ROUTING_CLASSES.classes.length);
    });
});
