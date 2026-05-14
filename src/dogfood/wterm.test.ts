import { describe, expect, test } from "bun:test";
import {
    createInteractiveDogfoodSession,
    createAgentctlSetupDemoScript,
    dogfoodStatusForTranscript,
    dogfoodClientJs,
    dogfoodHtml,
    parseDogfoodTerminalArgs,
    resolveDogfoodAgentPreset,
} from "./wterm.ts";

describe("wterm dogfood harness", () => {
    test("parses terminal dogfood args", () => {
        expect(parseDogfoodTerminalArgs([])).toMatchObject({
            scenario: "axctl-setup",
            port: 1742,
            json: false,
            transport: "auto",
        });
        expect(parseDogfoodTerminalArgs(["--scenario=axctl-setup", "--port=1844", "--json", "--transport=pty"])).toMatchObject({
            scenario: "axctl-setup",
            port: 1844,
            json: true,
            transport: "pty",
        });
        expect(parseDogfoodTerminalArgs(["--scenario=interactive", "--command=claude --dangerously-skip-permissions"])).toMatchObject({
            scenario: "interactive",
            command: "claude --dangerously-skip-permissions",
        });
        expect(parseDogfoodTerminalArgs(["--scenario=interactive", "--agent=claude"])).toMatchObject({
            scenario: "interactive",
            agent: "claude",
        });
        expect(parseDogfoodTerminalArgs(["--scenario=interactive", "--success-marker=READY", "--timeout=15"])).toMatchObject({
            successMarker: "READY",
            timeoutSeconds: 15,
        });
        expect(() => parseDogfoodTerminalArgs(["--scenario=unknown"])).toThrow("unknown dogfood scenario");
        expect(() => parseDogfoodTerminalArgs(["--port=0"])).toThrow("--port must be");
        expect(() => parseDogfoodTerminalArgs(["--transport=bad"])).toThrow("unknown dogfood transport");
        expect(() => parseDogfoodTerminalArgs(["--agent=bad"])).toThrow("unknown dogfood agent");
        expect(() => parseDogfoodTerminalArgs(["--timeout=0"])).toThrow("--timeout must be");
    });

    test("classifies transcript outcomes from markers and timeout", () => {
        expect(dogfoodStatusForTranscript({ transcript: "hello READY", successMarker: "READY", timedOut: false })).toMatchObject({
            status: "passed",
            markerFound: true,
        });
        expect(dogfoodStatusForTranscript({ transcript: "hello", successMarker: "READY", timedOut: false })).toMatchObject({
            status: "failed",
            markerFound: false,
        });
        expect(dogfoodStatusForTranscript({ transcript: "hello", timedOut: false })).toMatchObject({
            status: "completed",
            markerFound: false,
        });
        expect(dogfoodStatusForTranscript({ transcript: "hello READY", successMarker: "READY", timedOut: true })).toMatchObject({
            status: "timed_out",
            markerFound: true,
        });
    });

    test("resolves interactive agent presets to concrete commands", () => {
        expect(resolveDogfoodAgentPreset("shell").command).toBe("bash -l");
        expect(resolveDogfoodAgentPreset("claude").command).toContain("claude");
        expect(resolveDogfoodAgentPreset("codex").command).toContain("codex");
        expect(resolveDogfoodAgentPreset("opencode").command).toContain("opencode");
    });

    test("setup script demonstrates scratch onboarding and tracking baseline", async () => {
        const script = await createAgentctlSetupDemoScript("/repo/ax");

        expect(script.command).toContain("axctl wterm dogfood: fresh setup demo");
        expect(script.command).toContain("axctl onboarding --json");
        expect(script.command).toContain("chore: track agent harness");
        expect(script.command).toContain("AXCTL_DOGFOOD_SETUP_OK");
        expect(script.cwd).toContain("axctl-wterm-dogfood-");
    });

    test("interactive session starts a steerable shell in a scratch home", async () => {
        const session = await createInteractiveDogfoodSession({ agent: "shell", successMarker: "READY" });

        expect(session.command).toBe("bash -l");
        expect(session.title).toBe("interactive terminal");
        expect(session.agent).toBe("shell");
        expect(session.successMarker).toBe("READY");
        expect(session.cwd).toContain("axctl-wterm-dogfood-");
        expect(session.env.HOME).toContain("axctl-wterm-dogfood-");
    });

    test("interactive session accepts a custom agent command", async () => {
        const session = await createInteractiveDogfoodSession({ agent: "claude", command: "claude" });

        expect(session.command).toBe("claude");
        expect(session.agent).toBe("claude");
        expect(session.commandSource).toBe("override");
    });

    test("html and client load wterm through browser imports and websocket transport", () => {
        expect(dogfoodHtml()).toContain("@wterm/dom");
        expect(dogfoodHtml()).toContain("axctl dogfood terminal");
        expect(dogfoodClientJs()).toContain("new WTerm");
        expect(dogfoodClientJs()).toContain("WebSocketTransport");
        expect(dogfoodClientJs()).toContain("/api/terminal");
    });

    test("html exposes selected backend transport", () => {
        expect(dogfoodHtml("pty")).toContain("Transport: pty");
        expect(dogfoodHtml("process")).toContain("Transport: process");
    });
});
