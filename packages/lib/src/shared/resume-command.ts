/**
 * Resume-command builder - maps a session's `source` harness to the literal
 * shell command that resumes it. The single source of truth for "how do I
 * continue this session", consumed by the NavLink builders (MCP + CLI).
 *
 * Verified facts (2026-06-10):
 *   - codex: ax session id == provider rollout UUID (ingest/codex.ts), and
 *     `codex resume <SESSION_ID>` accepts it directly - no cwd needed, codex
 *     resolves rollouts from ~/.codex/sessions.
 *   - claude: session id == claude UUID v7. `claude --resume <uuid>` is
 *     project-dir scoped (transcripts live under ~/.claude/projects/<slug>/),
 *     so the `cd <cwd> && ` prefix is load-bearing when cwd is known.
 *   - claude-subagent: synthetic ids, not resumable - point at the parent.
 *   - pi / opencode / cursor: resume syntax unverified - deliberately emit
 *     nothing rather than teach an agent a command we haven't tested.
 */

import { type SessionId, toBareSessionId } from "./session-id.ts";

export type ResumeKind = "resume" | "parent" | "unsupported";

export interface ResumeAction {
	readonly kind: ResumeKind;
	/** Literal shell command, e.g. "cd /p && claude --resume <uuid>". Null unless kind="resume". */
	readonly command: string | null;
	/** Caveat or why-not, e.g. "subagent sessions are not resumable; open the parent". */
	readonly note: string | null;
}

export interface ResumeInput {
	/** Session id in any form - record-id decoration is stripped. */
	readonly sessionId: SessionId;
	/** Provider source: 'claude' | 'codex' | 'claude-subagent' | 'pi' | 'opencode' | 'cursor' | ... */
	readonly source: string;
	readonly cwd?: string | null;
	readonly parentSessionId?: SessionId | null;
}

/** Command templates - one constant each so a syntax fix is a one-line change. */
const CLAUDE_RESUME = (id: string): string => `claude --resume ${id}`;
const CODEX_RESUME = (id: string): string => `codex resume ${id}`;

const SHELL_SAFE_RE = /^[A-Za-z0-9_\-./~]+$/;

/** Single-quote a path for shell interpolation unless it's already safe. */
const shellPath = (p: string): string =>
	SHELL_SAFE_RE.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`;

export const buildResumeAction = (input: ResumeInput): ResumeAction => {
	const id = toBareSessionId(input.sessionId);
	switch (input.source) {
		case "claude": {
			if (input.cwd) {
				return {
					kind: "resume",
					command: `cd ${shellPath(input.cwd)} && ${CLAUDE_RESUME(id)}`,
					note: null,
				};
			}
			return {
				kind: "resume",
				command: CLAUDE_RESUME(id),
				note: "run from the session's project directory - claude resume is project-dir scoped",
			};
		}
		case "codex":
			return { kind: "resume", command: CODEX_RESUME(id), note: null };
		case "claude-subagent":
			return {
				kind: "parent",
				command: null,
				note: input.parentSessionId
					? `subagent sessions are not resumable - open the parent session ${toBareSessionId(input.parentSessionId)}`
					: "subagent sessions are not resumable - open the parent session",
			};
		default:
			return {
				kind: "unsupported",
				command: null,
				note: `resume not supported for source '${input.source}' yet`,
			};
	}
};
