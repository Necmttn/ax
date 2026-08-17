#!/usr/bin/env bun
/**
 * fetch-binaries.ts - vendor the `bun` binary the packaged studio-desktop app
 * spawns at runtime (`bun ... studio` / `bun ... ingest`, both on port/paths
 * derived from `DesktopEnvironment`).
 *
 * Wave 3 (`c-desktop-realign`): this used to also fetch `surreal` (spawned
 * alongside `ax serve`). ax moved off a required SurrealDB daemon onto
 * embedded DuckDB, and the desktop app now spawns a single `ax studio`
 * process instead of a surreal + ax-serve pair - there is nothing left for
 * this script to fetch a `surreal` binary for.
 *
 * Downloads a pinned bun release for the requested macOS arch(es) into
 * `resources/bin/<arch>/bun` and `chmod +x`es it. The output dir is
 * gitignored - the binary is fetched at build/release time, not committed.
 *
 * Usage:
 *   bun run scripts/fetch-binaries.ts                # host arch only
 *   bun run scripts/fetch-binaries.ts --arch=arm64,x64
 *   bun run scripts/fetch-binaries.ts --all          # both darwin arches
 *   bun run scripts/fetch-binaries.ts --update-hashes # recompute + print SHA256s
 *
 * Idempotent: skips the binary if it already exists and `--version` matches the
 * pinned version. SHA256 is verified against the recorded hash (when present),
 * and the binary is sanity-checked by running `--version`.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Exact pinned upstream version. Bump deliberately. */
const BUN_VERSION = "1.3.13";

/** Our internal arch dir names (match `DesktopEnvironment` path construction). */
type Arch = "arm64" | "x64";

/**
 * Per-release arch token. Upstream naming differs per arch. Confirmed against
 * the actual GitHub release assets (2026-06): `bun-darwin-{aarch64,x64}.zip`.
 */
const ARCH_TOKENS: Record<Arch, { bun: string }> = {
    arm64: { bun: "aarch64" },
    x64: { bun: "x64" },
};

/**
 * Expected SHA256 of the downloaded ARCHIVE (the `.zip`), keyed by arch, taken
 * from the upstream `SHASUMS256.txt` published with the release. Empty string
 * = not yet recorded (run with `--update-hashes`).
 */
const ARCHIVE_SHA256: Record<Arch, { bun: string }> = {
    arm64: {
        bun: "5467e3f65dba526b9fea98f0cce04efafc0c63e169733ec27b876a3ad32da190",
    },
    x64: {
        bun: "e5a6c8b64f419925232d111ecb13e25f0abf55e54f792341f987623fd0778009",
    },
};

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = dirname(HERE); // apps/studio-desktop
const BIN_ROOT = join(APP_ROOT, "resources", "bin");

const log = (msg: string) => process.stdout.write(`[fetch-binaries] ${msg}\n`);
const die = (msg: string): never => {
    process.stderr.write(`[fetch-binaries] ERROR: ${msg}\n`);
    process.exit(1);
};

function hostArch(): Arch {
    if (process.arch === "arm64") return "arm64";
    if (process.arch === "x64") return "x64";
    return die(`unsupported host arch: ${process.arch} (only arm64/x64)`);
}

function parseArchArgs(argv: string[]): Arch[] {
    if (argv.includes("--all")) return ["arm64", "x64"];
    const archFlag = argv.find((a) => a.startsWith("--arch="));
    if (!archFlag) return [hostArch()];
    const parts = archFlag
        .slice("--arch=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const archs: Arch[] = [];
    for (const p of parts) {
        if (p === "arm64" || p === "x64") archs.push(p);
        else die(`unknown --arch value: ${p} (expected arm64 or x64)`);
    }
    return archs.length ? archs : [hostArch()];
}

function sha256(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function download(url: string, dest: string): Promise<void> {
    log(`GET ${url}`);
    const res = await fetch(url);
    if (!res.ok) {
        die(`download failed (${res.status} ${res.statusText}) for ${url}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    await Bun.write(dest, buf);
}

/** Runs `<binPath> --version` and returns trimmed stdout (or null on failure). */
function probeVersion(binPath: string): string | null {
    const r = spawnSync(binPath, ["--version"], { encoding: "utf8" });
    if (r.status !== 0 || r.error) return null;
    return (r.stdout || "").trim();
}

/**
 * If a Mach-O binary was just written, macOS may SIGKILL it on first spawn until
 * it carries an (ad-hoc) signature. Apply an ad-hoc signature so the local
 * `--version` verification can run. No-op on non-darwin / if codesign missing.
 */
function adhocSign(binPath: string): void {
    if (process.platform !== "darwin") return;
    const r = spawnSync("codesign", ["--force", "--sign", "-", binPath], {
        encoding: "utf8",
    });
    if (r.status !== 0) {
        log(`warn: codesign ad-hoc sign failed for ${binPath} (continuing)`);
    }
}

function bunUrl(arch: Arch): string {
    const v = BUN_VERSION;
    const token = ARCH_TOKENS[arch].bun;
    return `https://github.com/oven-sh/bun/releases/download/bun-v${v}/bun-darwin-${token}.zip`;
}

function extractZip(archive: string, intoDir: string): void {
    const r = spawnSync("unzip", ["-o", "-q", archive, "-d", intoDir], {
        encoding: "utf8",
    });
    if (r.status !== 0) die(`unzip failed: ${r.stderr || r.stdout}`);
}

function findFile(dir: string, basename: string): string | null {
    // Recursive search - bun's zip extracts `bun-darwin-<arch>/bun`.
    const r = spawnSync("find", [dir, "-type", "f", "-name", basename], {
        encoding: "utf8",
    });
    if (r.status !== 0) return null;
    const first = (r.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean)[0];
    return first ?? null;
}

async function fetchBun(
    arch: Arch,
    opts: { updateHashes: boolean },
): Promise<{ recordedSha: string; version: string }> {
    const outDir = join(BIN_ROOT, arch);
    mkdirSync(outDir, { recursive: true });
    const finalPath = join(outDir, "bun");
    const expectedSha = ARCHIVE_SHA256[arch].bun;
    const url = bunUrl(arch);

    // Idempotency: skip if present + version matches.
    if (!opts.updateHashes && existsSync(finalPath)) {
        const existing = probeVersion(finalPath);
        if (existing && existing.includes(BUN_VERSION)) {
            log(`${arch}/bun: present & version OK (${existing}) - skip`);
            return { recordedSha: expectedSha, version: existing };
        }
        log(`${arch}/bun: present but version mismatch/unreadable - refetch`);
    }

    const work = join(tmpdir(), `ax-fetch-bun-${arch}-${Date.now()}`);
    mkdirSync(work, { recursive: true });
    const archive = join(work, "dl.zip");
    try {
        await download(url, archive);

        const got = sha256(archive);
        if (opts.updateHashes) {
            log(`${arch}/bun: archive SHA256 = ${got}`);
        } else if (expectedSha) {
            if (got !== expectedSha) {
                die(
                    `${arch}/bun: SHA256 mismatch\n  expected ${expectedSha}\n  got      ${got}\n  url ${url}`,
                );
            }
            log(`${arch}/bun: SHA256 verified`);
        } else {
            log(`${arch}/bun: no recorded SHA256 (got ${got}) - skipping archive checksum`);
        }

        extractZip(archive, work);

        const located = findFile(work, "bun");
        if (!located) {
            return die(`${arch}/bun: extracted binary not found in archive`);
        }

        // Move into place.
        await Bun.write(finalPath, Bun.file(located));
        await chmod(finalPath, 0o755);
        adhocSign(finalPath);

        const version = probeVersion(finalPath);
        if (!version) {
            return die(`${arch}/bun: binary failed to run --version after install`);
        }
        if (!version.includes(BUN_VERSION)) {
            return die(
                `${arch}/bun: --version (${version}) does not contain pinned version ${BUN_VERSION}`,
            );
        }
        log(`${arch}/bun: installed -> ${finalPath}`);
        log(`${arch}/bun: --version -> ${version}`);
        return { recordedSha: got, version };
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

async function main() {
    const argv = process.argv.slice(2);
    const updateHashes = argv.includes("--update-hashes");
    const archs = parseArchArgs(argv);

    log(`pinned: bun v${BUN_VERSION}`);
    log(`arch(es): ${archs.join(", ")}${updateHashes ? " (update-hashes)" : ""}`);

    const computed: Record<string, string | undefined> = {};

    for (const arch of archs) {
        const b = await fetchBun(arch, { updateHashes });
        computed[arch] = b.recordedSha;
    }

    if (updateHashes) {
        log("recorded SHA256 values (paste into ARCHIVE_SHA256):");
        for (const [arch, sha] of Object.entries(computed)) {
            log(`  ${arch}: bun=${sha}`);
        }
    }

    log("done.");
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
