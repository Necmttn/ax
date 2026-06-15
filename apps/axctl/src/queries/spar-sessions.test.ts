/**
 * Tests for spar-sessions.ts: fetchSparSessionIds.
 *
 * Uses the shared mock SurrealClient factory to assert the query shape and
 * filtering behaviour.
 */
import { describe, expect, it } from "bun:test";
import { makeMockDb, runWithMock } from "@ax/lib/testing/surreal";
import { fetchSparSessionIds } from "./spar-sessions.ts";

describe("fetchSparSessionIds", () => {
    it("returns ids of spar-labelled sessions", async () => {
        const db = makeMockDb([
            [
                [{ id: "session:⟨spar-abc⟩" }, { id: "session:⟨spar-def⟩" }],
            ],
        ]);
        const ids = await runWithMock(db, fetchSparSessionIds());
        expect(ids).toHaveLength(2);
        expect(ids).toContain("session:⟨spar-abc⟩");
        expect(ids).toContain("session:⟨spar-def⟩");
    });

    it("excludes unlabelled sessions (returns only spar rows)", async () => {
        // The DB query filters server-side; here the mock returns only the
        // matching rows. Verify no extras slip through the JS mapping.
        const db = makeMockDb([
            [
                [{ id: "session:⟨spar-only⟩" }],
            ],
        ]);
        const ids = await runWithMock(db, fetchSparSessionIds());
        expect(ids).toEqual(["session:⟨spar-only⟩"]);
    });

    it("returns [] when no spar sessions exist", async () => {
        // Empty result set from the DB.
        const db = makeMockDb([[[]]]);
        const ids = await runWithMock(db, fetchSparSessionIds());
        expect(ids).toEqual([]);
    });

    it("filters out falsy id strings from the row mapping", async () => {
        // Defensive: rows with a null/empty id should be dropped.
        const db = makeMockDb([
            [
                [{ id: "session:⟨valid⟩" }, { id: "" }, { id: null }],
            ],
        ]);
        const ids = await runWithMock(db, fetchSparSessionIds());
        expect(ids).toEqual(["session:⟨valid⟩"]);
    });

    it("issues a query containing the spar label filter", async () => {
        const db = makeMockDb();
        await runWithMock(db, fetchSparSessionIds());
        expect(db.captured[0]).toContain("string::contains(labels, 'spar')");
        expect(db.captured[0]).toContain("labels != NONE");
        expect(db.captured[0]).toContain("type::string(id) AS id");
    });
});
