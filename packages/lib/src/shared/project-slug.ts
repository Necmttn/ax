/**
 * Isomorphic - safe to import from server, CLI, TUI, or browser SPA.
 *
 * Cheap human-friendly project label from either a Claude-style cwd-slug like
 * `-Users-necmttn-Projects-myapp` or a real path like `/Users/necmttn/myapp`.
 * Falls back to the raw value when nothing else produces something useful.
 *
 * Container dirs (e.g. `Projects`, `workdir`) prettify to `(no repo)` because
 * the last segment alone tells the user nothing - codex sessions that ran at
 * `~/Projects` rather than inside a specific repo come through this path.
 */
const CONTAINER_DIRS = new Set([
    "Projects",
    "projects",
    "workdir",
    "code",
    "dev",
    "src",
    "repos",
    "Documents",
    "Desktop",
    "Downloads",
]);

const HOME_SEGMENTS = new Set(["Users", "home", "root"]);

/**
 * Encode an absolute repo/checkout path into the canonical `session.project`
 * key. Mirrors exactly how Claude Code names its `~/.claude/projects/<slug>`
 * directories - every `/` and `.` becomes `-`. Claude main-checkout sessions
 * therefore already carry the canonical key, while codex / pi / opencode /
 * cursor sessions (which store a raw cwd) and worktree checkouts converge onto
 * the identical key once the git stage canonicalizes them off the shared
 * `repository` edge. `prettifyProjectSlug` turns the result back into a label.
 */
export function pathToProjectSlug(path: string): string {
    return path.replace(/[/.]/g, "-");
}

/**
 * The display label for a session's project. Prefers the prettified
 * `session.project` key; when that resolves to `(no repo)` (a bare container
 * dir) or is absent, falls back to the cwd's last path segment, then to `-`.
 * Shared by the sessions list and the inspect header so both label a session
 * the same way.
 */
export function sessionProjectLabel(
    project: string | null | undefined,
    cwd: string | null | undefined,
): string {
    const pretty = project ? prettifyProjectSlug(project) : null;
    if (pretty && pretty !== "(no repo)" && pretty !== "?") return pretty;
    if (cwd) return cwd.split("/").filter(Boolean).pop() ?? "-";
    return "-";
}

export function prettifyProjectSlug(raw: unknown): string {
    if (raw == null) return "?";
    const s = String(raw);
    if (!s) return "?";
    if (s.includes("/")) {
        const parts = s.split("/").filter((p) => p.length > 0);
        const last = parts[parts.length - 1];
        if (!last) return "?";
        // /Users/necmttn or /home/necmttn -> "(no repo)" - user home, not a project.
        if (parts.length <= 2 && HOME_SEGMENTS.has(parts[0] ?? "")) return "(no repo)";
        if (CONTAINER_DIRS.has(last)) return "(no repo)";
        return last;
    }
    const trimmed = s.startsWith("-") ? s.slice(1) : s;
    const parts = trimmed.split("-").filter((p) => p.length > 0);
    const last = parts[parts.length - 1] ?? s;
    if (CONTAINER_DIRS.has(last)) return "(no repo)";
    return last;
}
