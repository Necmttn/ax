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
