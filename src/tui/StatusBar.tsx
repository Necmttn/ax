interface Props {
    readonly count: number;
    readonly total: number;
    readonly mode: "list" | "search";
    readonly error: string | null;
}

/**
 * Bottom bar: visible-vs-total counts on the left, hotkeys on the right.
 * Errors take precedence over the hotkey hints so they don't get hidden.
 */
export function StatusBar({ count, total, mode, error }: Props) {
    const hints =
        mode === "search"
            ? "type to filter · esc cancel · enter back to list"
            : "↑↓/jk navigate · / search · s sort · r reverse · q quit";

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
            </text>
            {error ? (
                <text fg="#f7768e">{error}</text>
            ) : (
                <text fg="#565f89">{hints}</text>
            )}
        </box>
    );
}
