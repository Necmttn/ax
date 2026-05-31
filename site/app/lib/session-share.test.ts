import { describe, expect, it } from "bun:test";
import {
  gistOwnerMatches,
  gistApiUrl,
  rawSessionFileUrlFromGist,
  validateShareArtifact,
} from "./session-share.ts";

function validArtifact() {
  return {
    schema_version: 1,
    exported_at: "2026-05-29T00:00:00.000Z",
    session: {
      id: "session-1",
      source: "codex",
      model: "gpt-5",
      project: "ax",
    },
    stats: {
      turns: 2,
      tool_calls: 3,
      files_changed: 1,
      skills_used: 1,
      failures: 0,
    },
    timeline: [
      {
        id: "event-1",
        kind: "message",
        title: "Started work",
        summary: "Loaded the task context.",
        ts: "2026-05-29T00:00:00.000Z",
        actor: "codex",
      },
    ],
    files: [
      {
        path: "site/app/routes/s.$owner.$gistId.tsx",
        role: "edited",
        lang: "tsx",
      },
    ],
    graph: {
      nodes: [],
      edges: [],
    },
    derived: {
      working_style: ["Reads local patterns before editing."],
    },
  };
}

describe("site session share helpers", () => {
  it("builds GitHub API URLs", () => {
    expect(gistApiUrl("abc123")).toBe("https://api.github.com/gists/abc123");
  });

  it("selects ax-session.json raw URL from a Gist response", () => {
    const raw = rawSessionFileUrlFromGist({
      owner: { login: "necmttn" },
      files: {
        "ax-session.json": {
          raw_url:
            "https://gist.githubusercontent.com/necmttn/abc/raw/ax-session.json",
        },
      },
    });

    expect(raw).toBe(
      "https://gist.githubusercontent.com/necmttn/abc/raw/ax-session.json",
    );
  });

  it("matches Gist owners case-insensitively", () => {
    expect(
      gistOwnerMatches({ owner: { login: "Necmttn" } }, "necmttn"),
    ).toBe(true);
    expect(
      gistOwnerMatches({ owner: { login: "someone-else" } }, "necmttn"),
    ).toBe(false);
  });

  it("validates schema version", () => {
    expect(() => validateShareArtifact({ schema_version: 999 })).toThrow(
      "Unsupported session share schema",
    );
  });

  it("rejects artifacts missing renderer dependencies", () => {
    expect(() => validateShareArtifact({ schema_version: 1 })).toThrow(
      "Invalid session share artifact",
    );
  });

  it("accepts a valid renderer artifact", () => {
    const artifact: unknown = validArtifact();

    expect(validateShareArtifact(artifact).session.id).toBe("session-1");
  });

  it("rejects timeline items that are not objects", () => {
    expect(() =>
      validateShareArtifact({ ...validArtifact(), timeline: [null] }),
    ).toThrow("Invalid session share artifact");
  });

  it("rejects invalid share turns", () => {
    expect(() =>
      validateShareArtifact({ ...validArtifact(), turns: [{ id: "turn-1" }] }),
    ).toThrow("Invalid session share artifact");
  });

  it("rejects file items that are not objects", () => {
    expect(() =>
      validateShareArtifact({ ...validArtifact(), files: [null] }),
    ).toThrow("Invalid session share artifact");
  });

  it("rejects artifacts missing exported_at", () => {
    const artifact: Record<string, unknown> = { ...validArtifact() };
    delete artifact.exported_at;

    expect(() => validateShareArtifact(artifact)).toThrow(
      "Invalid session share artifact",
    );
  });

  it("rejects artifacts with non-string exported_at", () => {
    expect(() =>
      validateShareArtifact({ ...validArtifact(), exported_at: 123 }),
    ).toThrow("Invalid session share artifact");
  });

  it("rejects artifacts with invalid stats", () => {
    expect(() =>
      validateShareArtifact({
        ...validArtifact(),
        stats: { ...validArtifact().stats, turns: "2" },
      }),
    ).toThrow("Invalid session share artifact");
  });

  it("rejects invalid working style items", () => {
    expect(() =>
      validateShareArtifact({
        ...validArtifact(),
        derived: { working_style: ["reads first", null] },
      }),
    ).toThrow("Invalid session share artifact");
  });

  it("rejects Gist responses without files", () => {
    expect(() => rawSessionFileUrlFromGist({})).toThrow(
      "Gist response has no files",
    );
  });

  it("rejects Gist responses without ax-session.json", () => {
    expect(() => rawSessionFileUrlFromGist({ files: {} })).toThrow(
      "Gist does not contain ax-session.json",
    );
  });

  it("rejects ax-session.json files without raw_url", () => {
    expect(() =>
      rawSessionFileUrlFromGist({
        files: {
          "ax-session.json": {},
        },
      }),
    ).toThrow("ax-session.json has no raw_url");
  });
});
