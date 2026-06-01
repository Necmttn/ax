interface Props {
    readonly value: string;
    readonly onChange: (next: string) => void;
    readonly focused: boolean;
}

/**
 * Single-line search input across the top of the dashboard. Filtering is
 * applied as the user types.
 */
export function SearchBar({ value, onChange, focused }: Props) {
    return (
        <box
            title={focused ? " search [active] " : " search "}
            style={{
                border: true,
                borderColor: focused ? "#7aa2f7" : "#414868",
                height: 3,
            }}
        >
            <input
                placeholder="type to filter - / to focus, esc to clear"
                value={value}
                onInput={onChange}
                focused={focused}
            />
        </box>
    );
}
