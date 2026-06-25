import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { dispatchEvent } from "./dispatch.ts";
import { decodeHookInput } from "./adapters/decode.ts";
import { readEnv } from "./event.ts";
import { GitEnvTest } from "./git-env.ts";
import enforceWorktreeWrite from "./hooks/enforce-worktree-write.ts";
import type { ProcessOutcome } from "./adapters/encode.ts";

const editOnMain = (axEnv?: Record<string, string>): string =>
  JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: "/repo/x.ts" },
    cwd: "/repo",
    ...(axEnv ? { _ax_env: axEnv } : {}),
  });

// /repo is a primary tree on `main` -> enforce-worktree-write blocks unless bypassed.
const gitMain = GitEnvTest({ roots: { "/repo": "/repo" }, branches: { "/repo": "main" } });

const run = (stdin: string): Promise<ProcessOutcome> =>
  Effect.runPromise(
    dispatchEvent(stdin, {}, [enforceWorktreeWrite]).pipe(Effect.provide(gitMain)),
  );

describe("decode: _ax_env -> event.env", () => {
  test("populates the forwarded env allowlist", () => {
    const ev = decodeHookInput(editOnMain({ ALLOW_MAIN_WRITE: "1" }), {});
    expect(ev.env).toEqual({ ALLOW_MAIN_WRITE: "1" });
  });

  test("drops non-string values and absent _ax_env is undefined", () => {
    expect(decodeHookInput(editOnMain(), {}).env).toBeUndefined();
    const ev = decodeHookInput(
      JSON.stringify({ hook_event_name: "PreToolUse", _ax_env: { A: "1", B: 2 } }),
      {},
    );
    expect(ev.env).toEqual({ A: "1" });
  });
});

describe("readEnv precedence", () => {
  test("event.env wins over process.env", () => {
    const ev = decodeHookInput(editOnMain({ ALLOW_MAIN_WRITE: "1" }), {});
    expect(readEnv(ev, "ALLOW_MAIN_WRITE")).toBe("1");
  });

  test("falls back to process.env when not forwarded", () => {
    const ev = decodeHookInput(editOnMain(), {});
    process.env.__AX_TEST_FWD = "yes";
    try {
      expect(readEnv(ev, "__AX_TEST_FWD")).toBe("yes");
    } finally {
      delete process.env.__AX_TEST_FWD;
    }
  });
});

describe("forwarded bypass reaches the guard (daemon correctness)", () => {
  test("Edit on main blocks without a forwarded bypass", async () => {
    const out = await run(editOnMain());
    expect(out.exitCode).toBe(2);
  });

  test("a forwarded ALLOW_MAIN_WRITE=1 unblocks it (env not in this process)", async () => {
    // process.env.ALLOW_MAIN_WRITE is unset here; only the payload carries it,
    // exactly as a daemon-evaluated hook would receive it.
    expect(process.env.ALLOW_MAIN_WRITE).toBeUndefined();
    const out = await run(editOnMain({ ALLOW_MAIN_WRITE: "1" }));
    expect(out.exitCode).toBe(0);
  });
});
