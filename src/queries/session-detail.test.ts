import { describe, expect, test } from "bun:test";
import { SESSION_FILE_EVIDENCE_SQL } from "./session-detail.ts";

describe("session detail queries", () => {
    test("file evidence reads shared relation tables without provider branches", () => {
        expect(SESSION_FILE_EVIDENCE_SQL).toContain("FROM edited");
        expect(SESSION_FILE_EVIDENCE_SQL).toContain("FROM read_file");
        expect(SESSION_FILE_EVIDENCE_SQL).toContain("FROM searched_file");
        expect(SESSION_FILE_EVIDENCE_SQL).toContain("WHERE in.session = $sessionId");
        expect(SESSION_FILE_EVIDENCE_SQL).not.toContain("provider =");
        expect(SESSION_FILE_EVIDENCE_SQL).not.toContain("source = \"claude\"");
        expect(SESSION_FILE_EVIDENCE_SQL).not.toContain("source = \"codex\"");
        expect(SESSION_FILE_EVIDENCE_SQL).not.toContain("source = \"pi\"");
    });
});
