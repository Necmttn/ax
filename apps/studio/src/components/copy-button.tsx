import { useState } from "react";

export function CopyButton({
    text,
    label = "Copy agent brief",
    className = "badge review",
}: {
    readonly text: string;
    readonly label?: string;
    readonly className?: string;
}) {
    const [copied, setCopied] = useState(false);
    return (
        <button
            type="button"
            className={className}
            onClick={() => {
                void navigator.clipboard.writeText(text).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                });
            }}
        >
            {copied ? "Copied ✓" : label}
        </button>
    );
}
