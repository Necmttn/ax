import { describe, expect, test } from "bun:test";
import {
    createInteractiveDogfoodSession,
    createAgentctlSetupDemoScript,
    dogfoodClientJs,
    dogfoodHtml,
    parseDogfoodTerminalArgs,
} from "./wterm.ts";

describe("wterm dogfood harness", () => {
    test("parses terminal dogfood args", () => {
        expect(parseDogfoodTerminalArgs([])).toMatchObject({
            scenario: "agentctl-setup",
            port: 1742,
            json: false,
            transport: "auto",
        });
        expect(parseDogfoodTerminalArgs(["--scenario=agentctl-setup", "--port=1844", "--json", "--transport=pty"])).toMatchObject({
            scenario: "agentctl-setup",
            port: 1844,
            json: true,
            transport: "pty",
        });
        expect(parseDogfoodTerminalArgs(["--scenario=interactive", "--command=claude --dangerously-skip-permissions"])).toMatchObject({
            scenario: "interactive",
            command: "claude --dangerously-skip-permissions",
        });
        expect(() => parseDogfoodTerminalArgs(["--scenario=unknown"])).toThrow("unknown dogfood scenario");
        expect(() => parseDogfoodTerminalArgs(["--port=0"])).toThrow("--port must be");
        expect(() => parseDogfoodTerminalArgs(["--transport=bad"])).toThrow("unknown dogfood transport");
    });

    test("setup script demonstrates scratch onboarding and tracking baseline", async () => {
        const script = await createAgentctlSetupDemoScript("/repo/agentctl");

        expect(script.command).toContain("agentctl wterm dogfood: fresh setup demo");
        expect(script.command).toContain("agentctl onboarding --json");
        expect(script.command).toContain("chore: track agent harness");
        expect(script.command).toContain("AGENTCTL_DOGFOOD_SETUP_OK");
        expect(script.cwd).toContain("agentctl-wterm-dogfood-");
    });

    test("interactive session starts a steerable shell in a scratch home", async () => {
        const session = await createInteractiveDogfoodSession({});

        expect(session.command).toBe("bash -l");
        expect(session.title).toBe("interactive terminal");
        expect(session.successMarker).toBeUndefined();
        expect(session.cwd).toContain("agentctl-wterm-dogfood-");
        expect(session.env.HOME).toContain("agentctl-wterm-dogfood-");
    });

    test("interactive session accepts a custom agent command", async () => {
        const session = await createInteractiveDogfoodSession({ command: "claude" });

        expect(session.command).toBe("claude");
    });

    test("html and client load wterm through browser imports and websocket transport", () => {
        expect(dogfoodHtml()).toContain("@wterm/dom");
        expect(dogfoodHtml()).toContain("agentctl dogfood terminal");
        expect(dogfoodClientJs()).toContain("new WTerm");
        expect(dogfoodClientJs()).toContain("WebSocketTransport");
        expect(dogfoodClientJs()).toContain("/api/terminal");
    });

    test("html exposes selected backend transport", () => {
        expect(dogfoodHtml("pty")).toContain("Transport: pty");
        expect(dogfoodHtml("process")).toContain("Transport: process");
    });
});
