import { homedir } from "node:os";
import { Effect, FileSystem, Path, PlatformError, Schema } from "effect";
import { skipNotFound } from "@ax/lib/shared/fs-error";

export const OTLP_ACK = { partialSuccess: {} } as const;
export const OTLP_SPOOL_RETENTION_DAYS = 90;

export class OtlpSpoolServerError extends Schema.TaggedErrorClass<OtlpSpoolServerError>(
    "OtlpSpoolServerError",
)("OtlpSpoolServerError", {
    message: Schema.String,
    cause: Schema.Defect(),
}) {}

const OTLP_PATHS = new Set(["/v1/metrics", "/v1/traces", "/v1/logs"]);
const DAY_MS = 86_400_000;
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export const defaultOtlpDataDir = (): string =>
    process.env.AX_DATA_DIR ?? `${homedir()}/.ax`;

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
    readonly dataDir?: string;
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
        const dataDir = opts.dataDir ?? defaultOtlpDataDir();
        const spoolDir = path.join(dataDir, "otlp", "spool");
        const hostname = opts.hostname ?? "127.0.0.1";
        const now = opts.now ?? (() => new Date());
        yield* fs.makeDirectory(spoolDir, { recursive: true });
        yield* pruneOtlpSpool({ spoolDir, now: now() });

        const runFs = Effect.runPromiseWith(context);

        let currentDay = dayKey(now());
        let writes: Promise<void> = Promise.resolve();

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
                await runFs(
                    fs.writeFileString(
                        path.join(spoolDir, `${nextDay}.jsonl`),
                        `${JSON.stringify(record)}\n`,
                        { flag: "a" },
                    ),
                );
            });
            return writes;
        };

        const server = yield* Effect.try({
            try: () => Bun.serve({
                hostname,
                port: opts.port ?? 1738,
                async fetch(request) {
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

        const boundPort = server.port ?? opts.port ?? 1738;
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
