import { describe, expect, test } from "bun:test";
import {
    duplicateRelationEdgesSql,
    duplicateFileIdentitySql,
    graphHealthSql,
    legacySkillCollisionSql,
    missingProducedScopeSql,
    providerEventIntegritySql,
    repositorySiblingSql,
} from "./graph-health.ts";

describe("graph health SQL", () => {
    test("duplicateFileIdentitySql groups by repository path", () => {
        expect(duplicateFileIdentitySql(10)).toContain("GROUP BY repository, path");
        expect(duplicateFileIdentitySql(10)).not.toContain("HAVING");
    });

    test("repositorySiblingSql checks canonical identity drift", () => {
        expect(repositorySiblingSql(10)).toContain("initial_commit");
        expect(repositorySiblingSql(10)).toContain("remote_url");
        expect(repositorySiblingSql(10)).not.toContain("HAVING");
    });

    test("missingProducedScopeSql checks valued produced fields", () => {
        expect(missingProducedScopeSql(10)).toContain("FROM produced");
        expect(missingProducedScopeSql(10)).toContain("repository IS NONE");
    });

    test("legacySkillCollisionSql finds lossy names", () => {
        expect(legacySkillCollisionSql(10)).toContain("string::replace");
        expect(legacySkillCollisionSql(10)).not.toContain("HAVING");
    });

    test("duplicateRelationEdgesSql checks semantic relation keys", () => {
        const sql = duplicateRelationEdgesSql(10);
        expect(sql).toContain("invoked");
        expect(sql).toContain("GROUP BY in, out, args");
        expect(sql).toContain("GROUP BY in, out, tool");
        expect(sql).toContain("GROUP BY in, out, kind");
        expect(sql).toContain("GROUP BY in, out, checkout");
        expect(sql).not.toContain("HAVING");
    });

    test("graphHealthSql embeds subqueries without inner terminators", () => {
        expect(graphHealthSql(10)).not.toContain(";),");
        expect(graphHealthSql(10)).toContain("duplicate_relation_edges");
    });

    test("providerEventIntegritySql reads provider event graph tables", () => {
        const sql = providerEventIntegritySql(10);
        expect(sql).toContain("FROM agent_event");
        expect(sql).toContain("FROM agent_session");
        expect(sql).toContain("FROM agent_provider");
    });
});
