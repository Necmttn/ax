import { describe, expect, test } from "bun:test";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect } from "effect";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    formatSseComment,
    formatSseEvent,
    handleImageRequest,
    handleEventsRequest,
    imageContentType,
    isPathWithinRoots,
    liveRoutes,
    recentIngestEventsSql,
    resolveConfinedImage,
} from "./live.ts";
import { matchRoute, type EffectRunner } from "../router.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const runFs = <A>(effect: Effect.Effect<A, unknown, import("effect").FileSystem.FileSystem>) =>
    Effect.runPromise(effect.pipe(Effect.provide(BunFileSystem.layer)));

/** Drain an SSE response body to text until it ends or `cancel` is called. */
async function drainStream(res: Response, runMs: number): Promise<string> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const pump = (async () => {
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) text += decoder.decode(value, { stream: true });
            }
        } catch {
            /* cancelled */
        }
    })();
    await sleep(runMs);
    await reader.cancel().catch(() => undefined);
    await pump;
    return text;
}

describe("imageContentType", () => {
    test("maps known image extensions (case-insensitive)", () => {
        expect(imageContentType("/a/x.png")).toBe("image/png");
        expect(imageContentType("/a/x.JPG")).toBe("image/jpeg");
        expect(imageContentType("/a/x.jpeg")).toBe("image/jpeg");
        expect(imageContentType("/a/x.webp")).toBe("image/webp");
        expect(imageContentType("/a/x.svg")).toBe("image/svg+xml");
        expect(imageContentType("/a/x.avif")).toBe("image/avif");
    });

    test("returns null for non-image / extensionless paths", () => {
        expect(imageContentType("/etc/passwd")).toBeNull();
        expect(imageContentType("/a/notes.txt")).toBeNull();
        expect(imageContentType("/a/script.sh")).toBeNull();
        expect(imageContentType("noext")).toBeNull();
    });
});

describe("confined image paths", () => {
    test("recognizes only exact roots and true descendants", () => {
        expect(isPathWithinRoots("/safe/images/shot.png", ["/safe/images"])).toBe(true);
        expect(isPathWithinRoots("/safe/images", ["/safe/images"])).toBe(true);
        expect(isPathWithinRoots("/safe/images-extra/shot.png", ["/safe/images"])).toBe(false);
        expect(isPathWithinRoots("/outside/shot.png", ["/safe/images"])).toBe(false);
    });

    test("rejects an existing image outside the allowed boundary", async () => {
        const base = await mkdtemp(join(tmpdir(), "ax-image-confine-"));
        const allowed = join(base, "allowed");
        const outside = join(base, "outside.png");
        try {
            await mkdir(allowed);
            await Bun.write(outside, "outside");
            await expect(runFs(resolveConfinedImage(outside, [allowed]))).resolves.toBeNull();
        } finally {
            await rm(base, { recursive: true, force: true });
        }
    });

    test("rejects .. traversal that resolves outside the allowed boundary", async () => {
        const base = await mkdtemp(join(tmpdir(), "ax-image-confine-"));
        const allowed = join(base, "allowed");
        const nested = join(allowed, "nested");
        const outside = join(base, "outside.png");
        try {
            await mkdir(nested, { recursive: true });
            await Bun.write(outside, "outside");
            const traversal = join(nested, "..", "..", "outside.png");
            await expect(runFs(resolveConfinedImage(traversal, [allowed]))).resolves.toBeNull();
        } finally {
            await rm(base, { recursive: true, force: true });
        }
    });

    test("rejects a symlink whose target escapes the allowed boundary", async () => {
        const base = await mkdtemp(join(tmpdir(), "ax-image-confine-"));
        const allowed = join(base, "allowed");
        const outside = join(base, "outside.png");
        const link = join(allowed, "linked.png");
        try {
            await mkdir(allowed);
            await Bun.write(outside, "outside");
            await symlink(outside, link);
            await expect(runFs(resolveConfinedImage(link, [allowed]))).resolves.toBeNull();
        } finally {
            await rm(base, { recursive: true, force: true });
        }
    });

    test("serves a legitimate image inside the allowed boundary", async () => {
        const base = await mkdtemp(join(tmpdir(), "ax-image-confine-"));
        const allowed = join(base, "allowed");
        const image = join(allowed, "shot.png");
        try {
            await mkdir(allowed);
            await Bun.write(image, "image bytes");
            await expect(runFs(resolveConfinedImage(image, [allowed]))).resolves.toBe(await realpath(image));

            const url = new URL(`http://127.0.0.1:1738/api/image?path=${encodeURIComponent(image)}`);
            const response = await handleImageRequest(url, [allowed]);
            expect(response.status).toBe(200);
            expect(response.headers.get("content-type")).toBe("image/png");
            await expect(response.text()).resolves.toBe("image bytes");
        } finally {
            await rm(base, { recursive: true, force: true });
        }
    });

    test("GET /api/image returns an actual 404 for an out-of-boundary image", async () => {
        const base = await mkdtemp(join(tmpdir(), "ax-image-confine-"));
        const allowed = join(base, "allowed");
        const outside = join(base, "outside.png");
        try {
            await mkdir(allowed);
            await Bun.write(outside, "outside");
            const url = new URL(`http://127.0.0.1:1738/api/image?path=${encodeURIComponent(outside)}`);
            const response = await handleImageRequest(url, [allowed]);
            expect(response.status).toBe(404);
        } finally {
            await rm(base, { recursive: true, force: true });
        }
    });
});

describe("dashboard live routes", () => {
    test("formatSseEvent emits valid SSE frame", () => {
        expect(formatSseEvent("message", { ok: true })).toBe('event: message\ndata: {"ok":true}\n\n');
    });

    test("formatSseComment emits an EventSource-ignored keep-alive line", () => {
        // A line starting with ':' is an SSE comment - EventSource never fires
        // a listener for it. This is the idle keep-alive that prevents the 60s
        // idleTimeout from reaping the socket mid-stream (issue #503).
        expect(formatSseComment("ping")).toBe(": ping\n\n");
        expect(formatSseComment("ping").startsWith(":")).toBe(true);
    });

    test("recentIngestEventsSql reads persisted ingest events", () => {
        const sql = recentIngestEventsSql("2026-05-10T00:00:00.000Z", 12);
        expect(sql).toContain("FROM ingest_event");
        expect(sql).toContain('WHERE ts > d"2026-05-10T00:00:00.000Z"');
        expect(sql).toContain("ORDER BY ts ASC");
        expect(sql).toContain("LIMIT 12");
    });

    test("POST /api/events matches the raw SSE route", () => {
        expect(matchRoute(liveRoutes, "POST", "/api/events").kind).toBe("matched");
    });

    test("/api/events emits a ready frame then keep-alive pings without DB rows", async () => {
        const runner = (async () => [[]]) as unknown as EffectRunner;
        const res = handleEventsRequest(runner, 10);
        expect(res.headers.get("content-type")).toBe("text/event-stream");
        const text = await drainStream(res, 60);
        expect(text).toContain("event: ready");
        // Multiple ticks at 10ms over ~60ms each write a keep-alive comment.
        expect(text).toContain(": ping");
    });

    test("/api/events serializes DB polls - at most one in flight per connection", async () => {
        let active = 0;
        let maxActive = 0;
        let calls = 0;
        // A poll far slower than the tick interval: without an in-flight guard,
        // setInterval would stack overlapping queries.
        const runner = (async () => {
            calls += 1;
            active += 1;
            maxActive = Math.max(maxActive, active);
            await sleep(40);
            active -= 1;
            return [[]];
        }) as unknown as EffectRunner;
        const res = handleEventsRequest(runner, 5);
        await drainStream(res, 80);
        expect(calls).toBeGreaterThan(0);
        expect(maxActive).toBeLessThanOrEqual(1);
    });

    test("/api/events tolerates a runner that throws (no unhandled rejection)", async () => {
        const runner = (async () => {
            throw new Error("db down");
        }) as unknown as EffectRunner;
        const res = handleEventsRequest(runner, 10);
        const text = await drainStream(res, 50);
        // The error is surfaced as an SSE event, the stream stays alive, and the
        // cancel path tears it down cleanly (no throw escapes drainStream).
        expect(text).toContain("event: error");
        expect(text).toContain("db down");
    });

    test("POST /api/image falls through to legacy API not_found", async () => {
        const { handleDashboardRequest } = await import("../../server.ts");
        const res = await handleDashboardRequest(
            new Request("http://127.0.0.1:1738/api/image", { method: "POST" }),
        );
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ error: "not_found" });
    });

    test("GET /api/ingest falls through to legacy API not_found", async () => {
        const { handleDashboardRequest } = await import("../../server.ts");
        const res = await handleDashboardRequest(
            new Request("http://127.0.0.1:1738/api/ingest"),
        );
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ error: "not_found" });
    });

    test("POST /api/ingest without a booted server falls through to not_found", async () => {
        // The ingest trigger is contract-served; without a booted server
        // there is no contract handler, and the legacy table no longer has
        // an ingest row - the /api/* not_found quirk answers. A booted
        // server (the only real deployment) routes this to the contract,
        // which 503s when the sidecar is down (covered in contract tests).
        const { handleDashboardRequest } = await import("../../server.ts");
        const res = await handleDashboardRequest(
            new Request("http://127.0.0.1:1738/api/ingest", { method: "POST", body: "{}" }),
        );
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ error: "not_found" });
    });
});
