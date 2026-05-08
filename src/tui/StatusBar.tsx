interface Props {
    readonly count: number;
    readonly total: number;
    readonly mode: "list" | "search";
    readonly error: string | null;
    readonly lastEvent?: { readonly skill: string; readonly ts: string } | null;
}

const formatLiveHint = (
    lastEvent: { readonly skill: string; readonly ts: string } | null | undefined,
): string | null => {
    if (!lastEvent) return null;
    // `out` is stored as `skill:<id>` - strip the prefix for display.
    const name = lastEvent.skill.replace(/^skill:⟨?/, "").replace(/⟩$/, "");
    return `live: ${name}`;
};

/**
 * Bottom bar: visible-vs-total counts on the left, hotkeys on the right.
 * Errors take precedence over the hotkey hints so they don't get hidden.
 * When a live invocation has just streamed in, surface a subtle "live: <skill>"
 * hint so the operator can see the dashboard is reactive without keypresses.
 */
export function StatusBar({ count, total, mode, error, lastEvent }: Props) {
    const hints =
        mode === "search"
            ? "type to filter · esc cancel · enter back to list"
            : "↑↓/jk navigate · / search · s sort · r reverse · q quit";
    const liveHint = formatLiveHint(lastEvent ?? null);

    return (
        <box
            style={{
                border: false,
                height: 1,
                paddingLeft: 1,
                paddingRight: 1,
                flexDirection: "row",
                justifyContent: "space-between",
            }}
        >
            <text fg="#7aa2f7">
                {error ? "" : `${count}/${total} skills`}
                {!error && liveHint ? `  ·  ${liveHint}` : ""}
            </text>
            {error ? (
                <text fg="#f7768e">{error}</text>
            ) : (
                <text fg="#565f89">{hints}</text>
            )}
        </box>
    );
}
