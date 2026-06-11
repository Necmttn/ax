import type { Harness } from "../event.ts";
import type { Verdict } from "../verdict.ts";

/** What the hook process should do: exit code + optional streams. */
export interface ProcessOutcome {
  readonly exitCode: 0 | 2;
  readonly stdout?: string | undefined;
  readonly stderr?: string | undefined;
}

/**
 * Exit-code contract is identical on claude + codex: 0 = allow,
 * 2 + stderr = block. Warn rides the `systemMessage` JSON field
 * (supported by both for PreToolUse). Inject = plain stdout (claude
 * SessionStart/UserPromptSubmit add stdout to context).
 */
export const encodeVerdict = (v: Verdict, _harness: Harness): ProcessOutcome => {
  switch (v._tag) {
    case "Allow":
      return { exitCode: 0 };
    case "Block":
      return { exitCode: 2, stderr: v.reason };
    case "Warn":
      return { exitCode: 0, stdout: JSON.stringify({ systemMessage: v.message }) };
    case "Inject":
      return { exitCode: 0, stdout: v.context };
  }
};
