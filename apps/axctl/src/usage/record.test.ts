import { describe, expect, it } from "bun:test";
import { redactInvocation } from "./record.ts";

describe("redactInvocation", () => {
  const base = { now: new Date("2026-06-15T12:00:00Z"), exitCode: 0, durationMs: 5, isTty: false, repoTopdir: "/Users/me/Projects/ax", version: "0.29.0" };

  it("keeps the subcommand path, drops positional args", () => {
    const r = redactInvocation(["sessions", "show", "abc-123-uuid"], base);
    expect(r.command).toBe("sessions show");
    expect(r.flags).toEqual([]);
  });
  it("keeps flag NAMES, strips flag values", () => {
    const r = redactInvocation(["recall", "secret query text", "--days=30", "--project=/Users/me/x", "--json"], base);
    expect(r.command).toBe("recall");
    expect(r.flags).toEqual(["--days", "--json", "--project"]);
  });
  it("repo_key is the lowercased basename, never the full path", () => {
    expect(redactInvocation(["digest"], base).repo_key).toBe("ax");
    expect(redactInvocation(["digest"], { ...base, repoTopdir: null }).repo_key).toBeNull();
  });
  it("origin from isTty", () => {
    expect(redactInvocation(["digest"], { ...base, isTty: true }).origin).toBe("tty");
    expect(redactInvocation(["digest"], { ...base, isTty: false }).origin).toBe("agent");
  });
  it("no positional value ever survives in command or flags", () => {
    const r = redactInvocation(["sessions", "show", "/Users/me/secret", "--here"], base);
    const blob = JSON.stringify(r);
    expect(blob).not.toContain("secret");
    expect(blob).not.toContain("/Users/me");
  });
  it("malformed positional[1] (a path) is NOT captured into command", () => {
    const r = redactInvocation(["sessions", "/Users/me/secret/path"], base);
    expect(r.command).toBe("sessions");
    const blob = JSON.stringify(r);
    expect(blob).not.toContain("secret");
    expect(blob).not.toContain("/Users/me");
  });
  it("tokens after -- (end-of-options) never reach command", () => {
    const r = redactInvocation(["ingest", "--", "secret"], base);
    expect(r.command).toBe("ingest");
    expect(JSON.stringify(r)).not.toContain("secret");
  });
  it("a non-command head is recorded as (unknown), never the raw token", () => {
    const r = redactInvocation(["/weird/path"], base);
    expect(r.command).toBe("(unknown)");
    expect(JSON.stringify(r)).not.toContain("weird");
  });
});
