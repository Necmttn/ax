import { posixPath } from "@ax/lib/shared/path";

/** Git paths must stay relative to the checkout, including Windows input. */
export function projectRelativePath(value: string): string | null {
    const path = value.replaceAll("\\", "/");
    if (path.includes("\0") || path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return null;
    const normalized = posixPath.normalize(path);
    return normalized === "." || normalized === ".." || normalized.startsWith("../") ? null : normalized;
}
