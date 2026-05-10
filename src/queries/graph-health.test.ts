import { describe, expect, test } from "bun:test";
import {
    duplicateFileIdentitySql,
    legacySkillCollisionSql,
    missingProducedScopeSql,
    repositorySiblingSql,
} from "./graph-health.ts";

describe("graph health SQL", () => {
    test("duplicateFileIdentitySql groups by repository path", () => {
        expect(duplicateFileIdentitySql(10)).toContain("GROUP BY repository, path");
    });

    test("repositorySiblingSql checks canonical identity drift", () => {
        expect(repositorySiblingSql(10)).toContain("initial_commit");
        expect(repositorySiblingSql(10)).toContain("remote_url");
    });

    test("missingProducedScopeSql checks valued produced fields", () => {
        expect(missingProducedScopeSql(10)).toContain("FROM produced");
        expect(missingProducedScopeSql(10)).toContain("repository IS NONE");
    });

    test("legacySkillCollisionSql finds lossy names", () => {
        expect(legacySkillCollisionSql(10)).toContain("string::replace");
    });
});
