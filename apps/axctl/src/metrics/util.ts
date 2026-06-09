import { recordLiteral } from "@ax/lib/ids";
import { recordKeyPart } from "@ax/lib/shared/derive-keys";

/** Comma-joined `session:`key`` record-literal IN-list body for the given session ids. */
export const sessionRefList = (sessionIds: readonly string[]): string =>
    sessionIds.map((id) => recordLiteral("session", recordKeyPart(id, "session") ?? "")).join(", ");

/** Set absent ids to a default (mutates + returns the map). */
export const fillDefaults = <V>(map: Map<string, V>, ids: readonly string[], def: V): Map<string, V> => {
    for (const id of ids) if (!map.has(id)) map.set(id, def);
    return map;
};

/** Parse an ISO datetime string to epoch ms, or null. */
export const isoMs = (iso: unknown): number | null => {
    if (typeof iso !== "string" || iso.length === 0) return null;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? t : null;
};
