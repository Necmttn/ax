#!/usr/bin/env bun
/**
 * fetch-binaries.ts - vendor the `surreal` + `bun` binaries the packaged
 * studio-desktop app spawns at runtime (surreal :8521, `bun ... serve` :1738).
 *
 * Downloads pinned releases for the requested macOS arch(es) into
 * `resources/bin/<arch>/{surreal,bun}` and `chmod +x` them. The output dir is
 * gitignored - binaries are fetched at build/release time, not committed.
 *
 * Usage:
 *   bun run scripts/fetch-binaries.ts                # host arch only
 *   bun run scripts/fetch-binaries.ts --arch=arm64,x64
 *   bun run scripts/fetch-binaries.ts --all          # both darwin arches
 *   bun run scripts/fetch-binaries.ts --update-hashes # recompute + print SHA256s
 *
 * Idempotent: skips a binary if it already exists and `--version` matches the
 * pinned version. SHA256 is verified against the recorded hashes (when present),
 * and every binary is sanity-checked by running `--version`.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Exact pinned upstream versions. Bump deliberately. */
const BINARY_VERSIONS = {
    surreal: "3.1.0",
    bun: "1.3.13",
} as const;

/** Our internal arch dir names (match `DesktopEnvironment` path construction). */
type Arch = "arm64" | "x64";

/**
 * Per-release arch tokens. Upstream naming differs per project / per arch.
 * Confirmed against the actual GitHub release assets (2026-06):
 *   surreal: surreal-v3.1.0.darwin-{amd64,arm64}.tgz
 *   bun:     bun-darwin-{aarch64,x64}.zip
 */
const ARCH_TOKENS: Record<Arch, { surreal: string; bun: string }> = {
    arm64: { surreal: "arm64", bun: "aarch64" },
    x64: { surreal: "amd64", bun: "x64" },
};

/**
 * Expected SHA256 of each downloaded ARCHIVE (the `.tgz` / `.zip`), keyed by
 * arch. Empty string = not yet recorded (run with `--update-hashes`).
 *
 * - bun: taken from the upstream `SHASUMS256.txt` published with the release.
 * - surreal: upstream publishes no checksum file, so these are computed-once
 *   values pinned here; verified on download.
 */
const ARCHIVE_SHA256: Record<Arch, { surreal: string; bun: string }> = {
    arm64: {
        surreal: "4acf3578e3cc1d57a23b44241b4dd5b30aabf8aebbe9b211430da33550f14d3d",
        bun: "5467e3f65dba526b9fea98f0cce04efafc0c63e169733ec27b876a3ad32da190",
    },
    x64: {
        surreal: "",
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

function surrealUrl(arch: Arch): string {
    const v = BINARY_VERSIONS.surreal;
    const token = ARCH_TOKENS[arch].surreal;
    return `https://github.com/surrealdb/surrealdb/releases/download/v${v}/surreal-v${v}.darwin-${token}.tgz`;
}

function bunUrl(arch: Arch): string {
    const v = BINARY_VERSIONS.bun;
    const token = ARCH_TOKENS[arch].bun;
    return `https://github.com/oven-sh/bun/releases/download/bun-v${v}/bun-darwin-${token}.zip`;
}

function extractTgz(archive: string, intoDir: string): void {
    const r = spawnSync("tar", ["-xzf", archive, "-C", intoDir], {
        encoding: "utf8",
    });
    if (r.status !== 0) die(`tar extract failed: ${r.stderr || r.stdout}`);
}

function extractZip(archive: string, intoDir: string): void {
    const r = spawnSync("unzip", ["-o", "-q", archive, "-d", intoDir], {
        encoding: "utf8",
    });
    if (r.status !== 0) die(`unzip failed: ${r.stderr || r.stdout}`);
}

interface FetchSpec {
    readonly name: "surreal" | "bun";
    readonly url: string;
    readonly archiveExt: ".tgz" | ".zip";
    readonly expectedSha: string;
    /** Returns the extracted binary path inside `workDir`, or null if not found. */
    readonly locate: (workDir: string) => string | null;
    /** Substring expected in `--version` output (the pinned version). */
    readonly versionNeedle: string;
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

async function fetchOne(
    arch: Arch,
    spec: FetchSpec,
    opts: { updateHashes: boolean },
): Promise<{ recordedSha: string; version: string }> {
    const outDir = join(BIN_ROOT, arch);
    mkdirSync(outDir, { recursive: true });
    const finalPath = join(outDir, spec.name);

    // Idempotency: skip if present + version matches.
    if (!opts.updateHashes && existsSync(finalPath)) {
        const existing = probeVersion(finalPath);
        if (existing && existing.includes(spec.versionNeedle)) {
            log(`${arch}/${spec.name}: present & version OK (${existing}) - skip`);
            return { recordedSha: spec.expectedSha, version: existing };
        }
        log(`${arch}/${spec.name}: present but version mismatch/unreadable - refetch`);
    }

    const work = join(tmpdir(), `ax-fetch-${spec.name}-${arch}-${Date.now()}`);
    mkdirSync(work, { recursive: true });
    const archive = join(work, `dl${spec.archiveExt}`);
    try {
        await download(spec.url, archive);

        const got = sha256(archive);
        if (opts.updateHashes) {
            log(`${arch}/${spec.name}: archive SHA256 = ${got}`);
        } else if (spec.expectedSha) {
            if (got !== spec.expectedSha) {
                die(
                    `${arch}/${spec.name}: SHA256 mismatch\n  expected ${spec.expectedSha}\n  got      ${got}\n  url ${spec.url}`,
                );
            }
            log(`${arch}/${spec.name}: SHA256 verified`);
        } else {
            log(`${arch}/${spec.name}: no recorded SHA256 (got ${got}) - skipping archive checksum`);
        }

        if (spec.archiveExt === ".tgz") extractTgz(archive, work);
        else extractZip(archive, work);

        const located = spec.locate(work);
        if (!located) {
            return die(
                `${arch}/${spec.name}: extracted binary not found in archive`,
            );
        }

        // Move into place.
        await Bun.write(finalPath, Bun.file(located));
        await chmod(finalPath, 0o755);
        adhocSign(finalPath);

        const version = probeVersion(finalPath);
        if (!version) {
            return die(
                `${arch}/${spec.name}: binary failed to run --version after install`,
            );
        }
        if (!version.includes(spec.versionNeedle)) {
            return die(
                `${arch}/${spec.name}: --version (${version}) does not contain pinned version ${spec.versionNeedle}`,
            );
        }
        log(`${arch}/${spec.name}: installed -> ${finalPath}`);
        log(`${arch}/${spec.name}: --version -> ${version}`);
        return { recordedSha: got, version };
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

async function main() {
    const argv = process.argv.slice(2);
    const updateHashes = argv.includes("--update-hashes");
    const archs = parseArchArgs(argv);

    log(`pinned: surreal v${BINARY_VERSIONS.surreal}, bun v${BINARY_VERSIONS.bun}`);
    log(`arch(es): ${archs.join(", ")}${updateHashes ? " (update-hashes)" : ""}`);

    const computed: Record<string, { surreal?: string; bun?: string }> = {};

    for (const arch of archs) {
        const surrealSpec: FetchSpec = {
            name: "surreal",
            url: surrealUrl(arch),
            archiveExt: ".tgz",
            expectedSha: ARCHIVE_SHA256[arch].surreal,
            locate: (work) => findFile(work, "surreal"),
            versionNeedle: BINARY_VERSIONS.surreal,
        };
        const bunSpec: FetchSpec = {
            name: "bun",
            url: bunUrl(arch),
            archiveExt: ".zip",
            expectedSha: ARCHIVE_SHA256[arch].bun,
            locate: (work) => findFile(work, "bun"),
            versionNeedle: BINARY_VERSIONS.bun,
        };

        const s = await fetchOne(arch, surrealSpec, { updateHashes });
        const b = await fetchOne(arch, bunSpec, { updateHashes });
        computed[arch] = { surreal: s.recordedSha, bun: b.recordedSha };
    }

    if (updateHashes) {
        log("recorded SHA256 values (paste into ARCHIVE_SHA256):");
        for (const [arch, v] of Object.entries(computed)) {
            log(`  ${arch}: surreal=${v.surreal} bun=${v.bun}`);
        }
    }

    log("done.");
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
