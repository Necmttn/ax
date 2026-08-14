import { homedir } from "node:os";
import { Effect, FileSystem, Path, PlatformError, Schema } from "effect";
import { DEFAULT_DASHBOARD_PORT } from "@ax/lib/dashboard-port";
import { skipNotFound } from "@ax/lib/shared/fs-error";
import { isAllowedHost } from "../dashboard/host-guard.ts";
import { OTLP_SIGNAL_PATHS } from "./signal.ts";

export const OTLP_ACK = { partialSuccess: {} } as const;
export const OTLP_SPOOL_RETENTION_DAYS = 90;

/**
 * Cap on a single OTLP request body. OTLP batches are small (a few KB of JSON
 * per export); this bound (disk-exhaustion / ingest-OOM defense) is generous
 * for a real exporter but refuses a multi-GB body that would balloon the daily
 * spool file and OOM the whole-file read on the ingest side.
 */
export const OTLP_MAX_BODY_BYTES = 8 * 1024 * 1024;

export class OtlpSpoolServerError extends Schema.TaggedErrorClass<OtlpSpoolServerError>(
    "OtlpSpoolServerError",
)("OtlpSpoolServerError", {
    message: Schema.String,
    cause: Schema.Defect(),
}) {}

const OTLP_PATHS = new Set(Object.keys(OTLP_SIGNAL_PATHS));
const DAY_MS = 86_400_000;
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * The spool dir is deliberately decoupled from `AX_DATA_DIR` (every other
 * `AX_DATA_DIR` consumer defaults to `~/.local/share/ax`, a different tree
 * entirely - keying the OTLP spool off it made `AX_DATA_DIR` overload two
 * unrelated roots). `AX_OTLP_SPOOL_DIR` is its own, dedicated override.
 */
export const defaultOtlpSpoolDir = (): string =>
    process.env.AX_OTLP_SPOOL_DIR ?? `${homedir()}/.ax/otlp/spool`;

const dayKey = (date: Date): string => date.toISOString().slice(0, 10);

export interface OtlpSpoolRecord {
    readonly received_at: string;
    readonly path: string;
    readonly body: string;
}

export interface PruneOtlpSpoolOptions {
    readonly spoolDir: string;
    readonly now: Date;
    readonly retentionDays?: number;
}

/** Remove complete daily spool files whose UTC date is older than retention. */
export const pruneOtlpSpool = (
    opts: PruneOtlpSpoolOptions,
): Effect.Effect<number, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const entries = yield* fs.readDirectory(opts.spoolDir).pipe(skipNotFound([] as string[]));
        const todayStart = Date.parse(`${dayKey(opts.now)}T00:00:00.000Z`);
        const cutoff = todayStart - (opts.retentionDays ?? OTLP_SPOOL_RETENTION_DAYS) * DAY_MS;
        let removed = 0;
        for (const entry of entries) {
            const match = FILE_RE.exec(entry);
            if (!match) continue;
            const fileTime = Date.parse(`${match[1]}T00:00:00.000Z`);
            if (!Number.isFinite(fileTime) || fileTime >= cutoff) continue;
            yield* fs.remove(path.join(opts.spoolDir, entry));
            removed += 1;
        }
        return removed;
    });

export interface StartOtlpSpoolServerOptions {
    readonly spoolDir?: string;
    readonly hostname?: string;
    readonly port?: number;
    readonly now?: () => Date;
}

export interface OtlpSpoolServer {
    readonly hostname: string;
    readonly port: number;
    readonly url: string;
    readonly stop: () => Promise<void>;
}

/** Start the database-free OTLP receiver and append each accepted request. */
export const startOtlpSpoolServer = (
    opts: StartOtlpSpoolServerOptions = {},
): Effect.Effect<
    OtlpSpoolServer,
    PlatformError.PlatformError | OtlpSpoolServerError,
    FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
        const spoolDir = opts.spoolDir ?? defaultOtlpSpoolDir();
        const hostname = opts.hostname ?? "127.0.0.1";
        const now = opts.now ?? (() => new Date());
        yield* fs.makeDirectory(spoolDir, { recursive: true });
        yield* pruneOtlpSpool({ spoolDir, now: now() });

        const runFs = Effect.runPromiseWith(context);

        let currentDay = dayKey(now());
        let writes: Promise<void> = Promise.resolve();

        // A crash mid-append (SIGKILL, power loss) can leave the LAST line of a
        // spool file without its trailing "\n" - the next append would then glue
        // its own record onto the torn tail, producing one undecodable line
        // instead of two. Every write THIS process makes always ends in "\n", so
        // once a file's tail has been verified it can only be re-torn by a crash
        // of THIS process (irrelevant - nothing appends after that) - checked at
        // most once per file path per process lifetime, not on every write.
        const newlineChecked = new Set<string>();
        const closeTornTail = async (filePath: string): Promise<string> => {
            if (newlineChecked.has(filePath)) return "";
            newlineChecked.add(filePath);
            const file = Bun.file(filePath);
            if (!(await file.exists())) return "";
            const size = file.size;
            if (size <= 0) return "";
            const tail = await file.slice(size - 1, size).text();
            return tail === "\n" ? "" : "\n";
        };

        const append = (pathname: string, body: string): Promise<void> => {
            writes = writes.catch(() => undefined).then(async () => {
                const receivedAt = now();
                const nextDay = dayKey(receivedAt);
                if (nextDay !== currentDay) {
                    currentDay = nextDay;
                    await runFs(pruneOtlpSpool({ spoolDir, now: receivedAt }));
                }
                const record: OtlpSpoolRecord = {
                    received_at: receivedAt.toISOString(),
                    path: pathname,
                    body,
                };
                const filePath = path.join(spoolDir, `${nextDay}.jsonl`);
                const tornTailFix = await closeTornTail(filePath);
                await runFs(
                    fs.writeFileString(
                        filePath,
                        `${tornTailFix}${JSON.stringify(record)}\n`,
                        { flag: "a" },
                    ),
                );
            });
            return writes;
        };

        const server = yield* Effect.try({
            try: () => Bun.serve({
                hostname,
                // Disk-exhaustion / ingest-OOM defense: Bun rejects a body larger
                // than this before fetch() runs (413), so a giant POST can never
                // reach the spool file.
                maxRequestBodySize: OTLP_MAX_BODY_BYTES,
                port: opts.port ?? DEFAULT_DASHBOARD_PORT,
                async fetch(request) {
                    // DNS-rebinding / browser telemetry-injection defense: a
                    // PRESENT, non-loopback Host header can only come from a
                    // browser page pointed at this loopback receiver. Reject it
                    // (a real exporter sends loopback or no Host at all).
                    if (!isAllowedHost(request.headers.get("host"))) {
                        return new Response("forbidden", { status: 403 });
                    }
                    const pathname = new URL(request.url).pathname;
                    if (request.method !== "POST" || !OTLP_PATHS.has(pathname)) {
                        return new Response("Not Found", { status: 404 });
                    }
                    const body = await request.text().catch(() => "");
                    await append(pathname, body).catch(() => undefined);
                    return Response.json(OTLP_ACK);
                },
            }),
            catch: (error) => new OtlpSpoolServerError({
                message: error instanceof Error ? error.message : String(error),
                cause: error,
            }),
        });

        let rolloverTimer: ReturnType<typeof setTimeout> | undefined;
        const scheduleRollover = (): void => {
            const value = now();
            const next = Date.UTC(
                value.getUTCFullYear(),
                value.getUTCMonth(),
                value.getUTCDate() + 1,
            );
            const delay = Math.max(1, next - value.getTime());
            rolloverTimer = setTimeout(() => {
                const valueAtRollover = now();
                currentDay = dayKey(valueAtRollover);
                void runFs(pruneOtlpSpool({ spoolDir, now: valueAtRollover }))
                    .catch(() => undefined)
                    .finally(scheduleRollover);
            }, delay);
            rolloverTimer.unref?.();
        };
        scheduleRollover();

        const boundPort = server.port ?? opts.port ?? DEFAULT_DASHBOARD_PORT;
        return {
            hostname,
            port: boundPort,
            url: `http://${hostname}:${boundPort}`,
            stop: async () => {
                if (rolloverTimer !== undefined) clearTimeout(rolloverTimer);
                await writes.catch(() => undefined);
                await server.stop(true);
            },
        };
    });
