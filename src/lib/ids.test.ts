import { describe, it, expect } from "bun:test";
import { recordLiteral, safeRecordKey } from "./ids.ts";

describe("recordLiteral", () => {
    it("valid key → returns table:`key`", () => {
        expect(recordLiteral("skill", "my-skill__abc123")).toBe("skill:`my-skill__abc123`");
    });

    it("valid key with special chars (not forbidden) → ok", () => {
        expect(recordLiteral("file", "src/lib/ids.ts")).toBe("file:`src/lib/ids.ts`");
    });

    it("backtick in key → throws", () => {
        expect(() => recordLiteral("skill", "bad`key")).toThrow(/recordLiteral: invalid record key/);
    });

    it("newline in key → throws", () => {
        expect(() => recordLiteral("skill", "bad\nkey")).toThrow(/recordLiteral: invalid record key/);
    });

    it("null byte in key → throws", () => {
        expect(() => recordLiteral("skill", "bad\x00key")).toThrow(/recordLiteral: invalid record key/);
    });

    it("empty key → throws", () => {
        expect(() => recordLiteral("skill", "")).toThrow(/recordLiteral: invalid record key/);
    });
});

describe("safeRecordKey", () => {
    it("valid key → returns key unchanged", () => {
        expect(safeRecordKey("v2__abc123")).toBe("v2__abc123");
    });

    it("backtick → throws with escaped char in message", () => {
        const err = (() => { try { safeRecordKey("a`b"); } catch (e) { return e; } })();
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain("\\`");
    });

    it("newline → throws with \\n in message", () => {
        const err = (() => { try { safeRecordKey("a\nb"); } catch (e) { return e; } })();
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain("\\n");
    });

    it("empty string → throws", () => {
        expect(() => safeRecordKey("")).toThrow(/empty key/);
    });
});
