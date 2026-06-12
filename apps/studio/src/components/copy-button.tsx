import { useState } from "react";

export function CopyButton({
    text,
    label = "Copy agent brief",
}: {
    readonly text: string;
    readonly label?: string;
}) {
    const [copied, setCopied] = useState(false);
    return (
        <button
            type="button"
            className="badge review"
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
