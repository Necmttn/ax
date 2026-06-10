import { describe, expect, test } from "bun:test";
import { buildResumeAction } from "./resume-command.ts";

const UUID = "019e2531-b552-7b53-a029-c780adbb6560";

describe("buildResumeAction", () => {
	test("claude with cwd → cd-prefixed claude --resume", () => {
		const a = buildResumeAction({
			sessionId: UUID,
			source: "claude",
			cwd: "/Users/x/proj",
		});
		expect(a.kind).toBe("resume");
		expect(a.command).toBe(`cd /Users/x/proj && claude --resume ${UUID}`);
	});

	test("claude without cwd → bare claude --resume with note", () => {
		const a = buildResumeAction({ sessionId: UUID, source: "claude" });
		expect(a.kind).toBe("resume");
		expect(a.command).toBe(`claude --resume ${UUID}`);
		expect(a.note).toContain("project directory");
	});

	test("claude cwd with shell-unsafe chars is quoted", () => {
		const a = buildResumeAction({
			sessionId: UUID,
			source: "claude",
			cwd: "/Users/x/my proj",
		});
		expect(a.command).toBe(`cd '/Users/x/my proj' && claude --resume ${UUID}`);
	});

	test("codex → codex resume, no cd prefix", () => {
		const a = buildResumeAction({
			sessionId: UUID,
			source: "codex",
			cwd: "/Users/x/proj",
		});
		expect(a.kind).toBe("resume");
		expect(a.command).toBe(`codex resume ${UUID}`);
	});

	test("claude-subagent → parent kind, no command", () => {
		const a = buildResumeAction({
			sessionId: "claude-subagent-abc123",
			source: "claude-subagent",
			parentSessionId: UUID,
		});
		expect(a.kind).toBe("parent");
		expect(a.command).toBeNull();
		expect(a.note).toContain("parent");
	});

	test("pi / opencode / cursor / unknown → unsupported, no command", () => {
		for (const source of ["pi", "opencode", "cursor", "mystery"]) {
			const a = buildResumeAction({ sessionId: UUID, source });
			expect(a.kind).toBe("unsupported");
			expect(a.command).toBeNull();
		}
	});

	test("session id is sanitized to bare form", () => {
		const a = buildResumeAction({
			sessionId: `session:⟨${UUID}⟩`,
			source: "codex",
		});
		expect(a.command).toBe(`codex resume ${UUID}`);
	});
});
