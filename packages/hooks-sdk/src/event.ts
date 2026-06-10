/** Harness that fired the hook. Mirrors `session.source` in the graph. */
export type Harness = "claude" | "codex";

export type HookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "SessionStart"
  | "UserPromptSubmit"
  | "Stop"
  | "SubagentStop"
  | "PreCompact"
  | "PermissionRequest";

/** Normalized hook payload - one shape across all harnesses. */
export interface HookEvent {
  readonly harness: Harness;
  /**
   * Raw event name as reported by the harness. Untrusted input - unknown
   * future event names flow through honestly (they just won't match any
   * hook). `HookEventName` stays the typed vocabulary for hook definitions.
   */
  readonly event: string;
  readonly sessionId: string | null;
  /** working dir of the agent at fire time; falls back to process cwd. */
  readonly cwd: string;
  /** null for non-tool events (SessionStart, Stop, ...). */
  readonly tool: {
    readonly name: string;
    readonly input: Record<string, unknown>;
  } | null;
  /** untouched raw payload for escape hatches. */
  readonly raw: Record<string, unknown>;
  /**
   * Set when stdin was non-empty but did not parse to a JSON object
   * (malformed JSON or a non-object value). Decode never throws; this is
   * how callers distinguish garbage input from a genuinely empty payload.
   */
  readonly parseError?: string | undefined;
}
