import { describe, expect, it } from "bun:test";
import { type NudgeEnv, type NudgeState, renderNudge, shouldShowNudge } from "./star-nudge.ts";

const tty: NudgeEnv = { isTTY: true, ci: false, silenced: false };
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000 * DAY;

describe("shouldShowNudge", () => {
    it("shows only after a value command (ingest, recall, retro, improve, ...)", () => {
        for (const cmd of ["ingest", "recall", "sessions", "skills", "improve", "retro"]) {
            expect(shouldShowNudge({}, tty, [cmd], NOW)).toBe(true);
        }
    });

    it("never shows on a non-TTY (agents, pipes, the watcher)", () => {
        expect(shouldShowNudge({}, { ...tty, isTTY: false }, ["ingest"], NOW)).toBe(false);
    });

    it("never shows in CI", () => {
        expect(shouldShowNudge({}, { ...tty, ci: true }, ["ingest"], NOW)).toBe(false);
    });

    it("respects AX_NO_NUDGE / AX_NUDGE=off (silenced)", () => {
        expect(shouldShowNudge({}, { ...tty, silenced: true }, ["ingest"], NOW)).toBe(false);
    });

    it("never shows once starred/dismissed", () => {
        expect(shouldShowNudge({ starred: true }, tty, ["ingest"], NOW)).toBe(false);
    });

    it("rate-limits to once per 24h", () => {
        const justShown: NudgeState = { lastShownAt: NOW - DAY / 2 };
        expect(shouldShowNudge(justShown, tty, ["ingest"], NOW)).toBe(false);
        const yesterday: NudgeState = { lastShownAt: NOW - DAY - 1 };
        expect(shouldShowNudge(yesterday, tty, ["ingest"], NOW)).toBe(true);
    });

    it("skips help, json, bare, and flag-only invocations", () => {
        expect(shouldShowNudge({}, tty, [], NOW)).toBe(false);
        expect(shouldShowNudge({}, tty, ["--help"], NOW)).toBe(false);
        expect(shouldShowNudge({}, tty, ["sessions", "--help"], NOW)).toBe(false);
        expect(shouldShowNudge({}, tty, ["recall", "--json"], NOW)).toBe(false);
    });

    it("never nudges after maintenance / own-UI / non-value commands", () => {
        for (const cmd of ["star", "version", "completions", "tui", "serve", "doctor", "install", "update", "daemon", "uninstall"]) {
            expect(shouldShowNudge({}, tty, [cmd], NOW)).toBe(false);
        }
    });
});

describe("renderNudge", () => {
    it("links the repo and the issue tracker, and documents the opt-outs", () => {
        const out = renderNudge();
        expect(out).toContain("https://github.com/Necmttn/ax");
        expect(out).toContain("/issues/new");
        expect(out).toContain("ax star --done");
        expect(out).toContain("AX_NO_NUDGE=1");
    });
});
