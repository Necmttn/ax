import { describe, expect, it } from "bun:test";
import {
    buildLoadedEdges,
    renderLoadedEdge,
    type SpawnInput,
} from "./derive-loaded-skills.ts";

const agentSkills = new Map<string, ReadonlyArray<string>>([
    ["code-reviewer", ["composto", "react-doctor"]],
    ["gtm-prospector", ["gtm-meta-skill"]],
]);
const skillIdByName = new Map<string, string>([
    ["composto", "skill:composto"],
    ["react-doctor", "skill:react_doctor"],
    ["gtm-meta-skill", "skill:gtm"],
]);

describe("buildLoadedEdges", () => {
    it("resolves agent -> declared skills -> skill ids, one edge each", () => {
        const spawns: SpawnInput[] = [
            { child: "session:s1", agentName: "code-reviewer", agentType: null, ts: "2026-06-16T10:00:00.000Z" },
        ];
        const edges = buildLoadedEdges(spawns, agentSkills, skillIdByName);
        expect(edges).toEqual([
            { child: "session:s1", skillId: "skill:composto", agent: "code-reviewer", ts: "2026-06-16T10:00:00.000Z" },
            { child: "session:s1", skillId: "skill:react_doctor", agent: "code-reviewer", ts: "2026-06-16T10:00:00.000Z" },
        ]);
    });

    it("falls back from agentName to agentType when name doesn't match", () => {
        const spawns: SpawnInput[] = [
            { child: "session:s2", agentName: "Babbage", agentType: "gtm-prospector", ts: "2026-06-16T11:00:00.000Z" },
        ];
        const edges = buildLoadedEdges(spawns, agentSkills, skillIdByName);
        expect(edges.map((e) => e.skillId)).toEqual(["skill:gtm"]);
        expect(edges[0].agent).toBe("gtm-prospector");
    });

    it("skips spawns whose agent has no skills frontmatter", () => {
        const spawns: SpawnInput[] = [
            { child: "session:s3", agentName: "unknown-agent", agentType: "Explore", ts: "2026-06-16T12:00:00.000Z" },
        ];
        expect(buildLoadedEdges(spawns, agentSkills, skillIdByName)).toEqual([]);
    });

    it("skips skills that aren't in the catalog", () => {
        const partial = new Map([["composto", "skill:composto"]]); // react-doctor missing
        const spawns: SpawnInput[] = [
            { child: "session:s4", agentName: "code-reviewer", agentType: null, ts: "2026-06-16T10:00:00.000Z" },
        ];
        const edges = buildLoadedEdges(spawns, agentSkills, partial);
        expect(edges.map((e) => e.skillId)).toEqual(["skill:composto"]);
    });

    it("dedupes (child, skill) across repeat spawns, keeping the earliest ts", () => {
        const spawns: SpawnInput[] = [
            { child: "session:s5", agentName: "gtm-prospector", agentType: null, ts: "2026-06-16T15:00:00.000Z" },
            { child: "session:s5", agentName: "gtm-prospector", agentType: null, ts: "2026-06-16T09:00:00.000Z" },
        ];
        const edges = buildLoadedEdges(spawns, agentSkills, skillIdByName);
        expect(edges).toHaveLength(1);
        expect(edges[0].ts).toBe("2026-06-16T09:00:00.000Z");
    });

    it("ignores spawns with an empty child id", () => {
        const spawns: SpawnInput[] = [
            { child: "", agentName: "code-reviewer", agentType: null, ts: "2026-06-16T10:00:00.000Z" },
        ];
        expect(buildLoadedEdges(spawns, agentSkills, skillIdByName)).toEqual([]);
    });
});

describe("renderLoadedEdge", () => {
    it("emits a deterministic RELATE with escaped record refs", () => {
        const sql = renderLoadedEdge({
            child: "session:abc",
            skillId: "skill:composto",
            agent: "code-reviewer",
            ts: "2026-06-16T10:00:00.000Z",
        });
        expect(sql).toContain("RELATE session:`abc`->loaded:`");
        expect(sql).toContain("->skill:`composto`");
        expect(sql).toContain('agent = "code-reviewer"');
        expect(sql).toContain("source = 'frontmatter'");
        expect(sql).toContain('d"2026-06-16T10:00:00.000Z"');
    });

    it("is deterministic for the same (child, skill)", () => {
        const e = { child: "session:abc", skillId: "skill:x", agent: "a", ts: "2026-06-16T10:00:00.000Z" };
        expect(renderLoadedEdge(e)).toBe(renderLoadedEdge(e));
    });

    it("returns null when an id can't be parsed", () => {
        expect(renderLoadedEdge({ child: "", skillId: "skill:x", agent: "a", ts: "2026-06-16T10:00:00.000Z" })).toBeNull();
    });
});
