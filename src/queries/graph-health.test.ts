import { describe, expect, test } from "bun:test";
import {
    duplicateFileIdentitySql,
    graphHealthSql,
    legacySkillCollisionSql,
    missingProducedScopeSql,
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

    test("graphHealthSql embeds subqueries without inner terminators", () => {
        expect(graphHealthSql(10)).not.toContain(";),");
    });
});
