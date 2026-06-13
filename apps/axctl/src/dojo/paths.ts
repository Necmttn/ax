import { homedir } from "node:os";
import { posixPath } from "@ax/lib/shared/path";

export const defaultDojoDir = (): string =>
    posixPath.join(homedir(), ".ax", "dojo");

export const dojoOutboxDir = (base: string = defaultDojoDir()): string =>
    posixPath.join(base, "outbox");

export const dojoReportsDir = (base: string = defaultDojoDir()): string =>
    posixPath.join(base, "reports");

export const dojoSparDir = (base: string = defaultDojoDir()): string =>
    posixPath.join(base, "spar");

export const dojoSparBriefPath = (id: string, base: string = defaultDojoDir()): string =>
    posixPath.join(dojoSparDir(base), `${id}.md`);

export const dojoSparReportPath = (id: string, base: string = defaultDojoDir()): string =>
    posixPath.join(dojoSparDir(base), `${id}-report.md`);

/** date is YYYY-MM-DD */
export const dojoReportPath = (date: string, base: string = defaultDojoDir()): string =>
    posixPath.join(dojoReportsDir(base), `${date}.md`);

/** Local YYYY-MM-DD for an epoch-ms timestamp (the report filename's date). */
export const localDate = (ms: number): string => {
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = `${d.getMonth() + 1}`.padStart(2, "0");
    const day = `${d.getDate()}`.padStart(2, "0");
    return `${y}-${m}-${day}`;
};
