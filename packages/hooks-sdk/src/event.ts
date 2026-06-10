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
  readonly event: HookEventName;
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
}
