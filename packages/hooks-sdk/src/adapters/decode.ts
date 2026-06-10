import type { Harness, HookEvent } from "../event.ts";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asRecord = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * Normalize raw hook input into a HookEvent.
 * Priority: stdin JSON (claude + codex contract) → legacy env vars
 * (`TOOL_NAME`/`TOOL_INPUT_command`/`CWD`, the pre-2026 claude shape).
 * Harness detection: codex payloads carry `turn_id`/`tool_use_id`.
 * Never throws; garbage stdin surfaces as `parseError` on the result.
 */
export const decodeHookInput = (
  stdinText: string,
  env: Record<string, string | undefined>,
): HookEvent => {
  let raw: Record<string, unknown> = {};
  let parseError: string | undefined;
  if (stdinText.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(stdinText);
      if (isRecord(parsed)) {
        raw = parsed;
      } else {
        parseError = `expected a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`;
      }
    } catch (err) {
      parseError = String(err);
    }
  }

  if (Object.keys(raw).length === 0 && env.TOOL_NAME) {
    const input: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(env)) {
      if (k.startsWith("TOOL_INPUT_") && v !== undefined) input[k.slice("TOOL_INPUT_".length)] = v;
    }
    return {
      harness: "claude",
      event: "PreToolUse",
      sessionId: null,
      cwd: env.CWD ?? process.cwd(),
      tool: { name: env.TOOL_NAME, input },
      raw: {},
      parseError,
    };
  }

  const harness: Harness = raw.turn_id !== undefined || raw.tool_use_id !== undefined ? "codex" : "claude";
  const toolName = str(raw.tool_name);
  return {
    harness,
    event: str(raw.hook_event_name) ?? "PreToolUse",
    sessionId: str(raw.session_id),
    cwd: str(raw.cwd) ?? process.cwd(),
    tool: toolName ? { name: toolName, input: asRecord(raw.tool_input) } : null,
    raw,
    parseError,
  };
};
