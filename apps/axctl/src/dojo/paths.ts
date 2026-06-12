import { homedir } from "node:os";
import { posixPath } from "@ax/lib/shared/path";

export const defaultDojoDir = (): string =>
    posixPath.join(homedir(), ".ax", "dojo");

export const dojoOutboxDir = (base: string = defaultDojoDir()): string =>
    posixPath.join(base, "outbox");

export const dojoReportsDir = (base: string = defaultDojoDir()): string =>
    posixPath.join(base, "reports");

/** date is YYYY-MM-DD */
export const dojoReportPath = (date: string, base: string = defaultDojoDir()): string =>
    posixPath.join(dojoReportsDir(base), `${date}.md`);
