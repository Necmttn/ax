/**
 * Tests for spar-sessions.ts: fetchSparSessionIds.
 *
 * Uses the shared mock SurrealClient factory to assert the query shape and
 * filtering behaviour. fetchSparSessionIds returns RAW RecordId values (via
 * SELECT VALUE id) - NOT strings - so the weighted-path NOT IN comparison is
 * record-vs-record. These unit tests assert the structural contract (RecordId
 * instances, correct query shape); they CANNOT validate NOT IN semantics - the
 * mock layer never evaluates SurrealQL. True semantic validation is the
 * live-DB before/after check documented in the spar-exclusion design.
 */
import { describe, expect, it } from "bun:test";
import { RecordId } from "surrealdb";
import { makeMockDb, runWithMock } from "@ax/lib/testing/surreal";
import { fetchSparSessionIds } from "./spar-sessions.ts";

const rid = (uuid: string) => new RecordId("session", uuid);

describe("fetchSparSessionIds", () => {
    it("returns RecordId values of spar-labelled sessions", async () => {
        const db = makeMockDb([
            [[rid("spar-abc"), rid("spar-def")]],
        ]);
        const ids = await runWithMock(db, fetchSparSessionIds());
        expect(ids).toHaveLength(2);
        // Contract: every element is a RecordId (NOT a string) so the
        // downstream NOT IN $sparSessions is record-typed.
        expect(ids.every((id) => id instanceof RecordId)).toBe(true);
        expect(ids.map((id) => String(id))).toContain("session:⟨spar-abc⟩");
        expect(ids.map((id) => String(id))).toContain("session:⟨spar-def⟩");
    });

    it("excludes unlabelled sessions (returns only spar rows)", async () => {
        // The DB query filters server-side; here the mock returns only the
        // matching rows. Verify no extras slip through the JS mapping.
        const db = makeMockDb([
            [[rid("spar-only")]],
        ]);
        const ids = await runWithMock(db, fetchSparSessionIds());
        expect(ids).toHaveLength(1);
        expect(String(ids[0])).toBe("session:⟨spar-only⟩");
    });

    it("returns [] when no spar sessions exist", async () => {
        // Empty result set from the DB.
        const db = makeMockDb([[[]]]);
        const ids = await runWithMock(db, fetchSparSessionIds());
        expect(ids).toEqual([]);
    });

    it("drops non-RecordId rows defensively (only RecordId instances survive)", async () => {
        // SELECT VALUE id should only ever return RecordIds, but guard against
        // a stray string/null slipping through.
        const db = makeMockDb([
            [[rid("valid"), "session:⟨string-form⟩", null]],
        ]);
        const ids = await runWithMock(db, fetchSparSessionIds());
        expect(ids).toHaveLength(1);
        expect(ids[0]).toBeInstanceOf(RecordId);
        // "valid" is unquoted-safe (alphanumeric), so no ⟨⟩ wrapping.
        expect(String(ids[0])).toBe("session:valid");
    });

    it("issues a SELECT VALUE id query containing the spar label filter", async () => {
        const db = makeMockDb();
        await runWithMock(db, fetchSparSessionIds());
        // Must use SELECT VALUE id (raw RecordIds), NOT type::string(id) (strings):
        // the string form makes NOT IN a no-op against record<session> fields.
        expect(db.captured[0]).toContain("SELECT VALUE id");
        expect(db.captured[0]).not.toContain("type::string(id)");
        expect(db.captured[0]).toContain("string::contains(labels, 'spar')");
        expect(db.captured[0]).toContain("labels != NONE");
    });
});
