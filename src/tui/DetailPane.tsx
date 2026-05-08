import type { SkillDetailRecord } from "./hooks/useSkillDetail.ts";

interface Props {
    readonly data: SkillDetailRecord | null;
    readonly loading: boolean;
    readonly error: string | null;
    readonly empty: boolean;
}

const SPARK_GLYPHS = ["·", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/** Bucketize daily timestamps into a 30-day count array (oldest → newest). */
function buildDailyBuckets(
    daily: SkillDetailRecord["daily"],
    days = 30,
): number[] {
    const buckets = Array<number>(days).fill(0);
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const start = now - days * dayMs;
    for (const d of daily) {
        const t = Date.parse(d.ts);
        if (Number.isNaN(t) || t < start) continue;
        const idx = Math.min(days - 1, Math.floor((t - start) / dayMs));
        buckets[idx] = (buckets[idx] ?? 0) + 1;
    }
    return buckets;
}

function spark(buckets: number[]): string {
    const max = buckets.reduce((m, v) => (v > m ? v : m), 0);
    if (max === 0) return "·".repeat(buckets.length);
    return buckets
        .map((v) => {
            const ratio = v / max;
            const idx = Math.min(
                SPARK_GLYPHS.length - 1,
                Math.max(0, Math.round(ratio * (SPARK_GLYPHS.length - 1))),
            );
            return SPARK_GLYPHS[idx] ?? "·";
        })
        .join("");
}

const formatTs = (iso: string | null): string => {
    if (!iso) return "never";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "?";
    return d.toISOString().slice(0, 16).replace("T", " ");
};

const truncate = (s: string, n: number): string =>
    s.length > n ? s.slice(0, n - 1) + "…" : s;

/**
 * Right-hand pane: header, sparkline, recent invocation list, body excerpt.
 * Empty/loading/error states all take the same outer box so layout doesn't jump.
 */
export function DetailPane({ data, loading, error, empty }: Props) {
    if (empty) {
        return (
            <box
                title=" detail "
                style={{ border: true, flexGrow: 1, paddingLeft: 1, paddingRight: 1 }}
            >
                <text fg="#a9b1d6">No skill selected - use ↑↓ or j/k.</text>
            </box>
        );
    }
    if (loading) {
        return (
            <box title=" detail " style={{ border: true, flexGrow: 1 }}>
                <text fg="#7aa2f7">Loading…</text>
            </box>
        );
    }
    if (error) {
        return (
            <box title=" detail " style={{ border: true, flexGrow: 1 }}>
                <text fg="#f7768e">Error: {error}</text>
            </box>
        );
    }
    if (!data || !data.skill) {
        return (
            <box title=" detail " style={{ border: true, flexGrow: 1 }}>
                <text fg="#a9b1d6">No data.</text>
            </box>
        );
    }

    const { skill, invocations, recent, daily } = data;
    const buckets = buildDailyBuckets(daily);
    const sparkLine = spark(buckets);
    const description =
        typeof skill.description === "string" && skill.description.length > 0
            ? skill.description
            : null;
    const body = typeof skill.body === "string" ? skill.body : "";
    const bodyExcerpt = body.length > 500 ? body.slice(0, 500) + "…" : body;

    return (
        <box
            title=" detail "
            style={{
                border: true,
                flexGrow: 1,
                flexDirection: "column",
                paddingLeft: 1,
                paddingRight: 1,
            }}
        >
            <text>
                <span fg="#bb9af7">{skill.name}</span>
                <span fg="#565f89"> · </span>
                <span fg="#7aa2f7">{skill.scope}</span>
            </text>
            {description && <text fg="#a9b1d6">{truncate(description, 200)}</text>}
            <text> </text>

            <text fg="#7aa2f7">
                invocations · 7d {invocations.d7} · 30d {invocations.d30} · total{" "}
                {invocations.total} · last {formatTs(invocations.last)}
            </text>
            <text fg="#9ece6a">{sparkLine}</text>
            <text fg="#414868">└ 30 days (oldest→newest) ─ peak {Math.max(...buckets, 0)}</text>
            <text> </text>

            <text fg="#bb9af7">recent invocations</text>
            {recent.length === 0 ? (
                <text fg="#565f89">  (none)</text>
            ) : (
                recent.map((r, i) => (
                    <text key={`${r.ts}-${i}`} fg="#c0caf5">
                        {`  ${formatTs(r.ts)}  ${r.project ?? "-"}`}
                    </text>
                ))
            )}
            <text> </text>

            <text fg="#bb9af7">body excerpt</text>
            {bodyExcerpt.length === 0 ? (
                <text fg="#565f89">  (no body)</text>
            ) : (
                bodyExcerpt
                    .split("\n")
                    .slice(0, 18)
                    .map((line, i) => (
                        <text key={`body-${i}`} fg="#a9b1d6">
                            {truncate(line, 120)}
                        </text>
                    ))
            )}
        </box>
    );
}
