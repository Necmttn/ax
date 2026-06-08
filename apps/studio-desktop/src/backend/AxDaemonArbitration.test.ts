import { expect, test } from "bun:test";
import { decideArbitration } from "./AxDaemonArbitration.ts";

test("both healthy -> attach", () => {
    expect(decideArbitration({ daemonHealthy: true, surrealHealthy: true, portsFree: false }))
        .toEqual({ mode: "attach" });
});
test("ports free -> spawn", () => {
    expect(decideArbitration({ daemonHealthy: false, surrealHealthy: false, portsFree: true }))
        .toEqual({ mode: "spawn" });
});
test("port occupied but unhealthy -> conflict", () => {
    expect(decideArbitration({ daemonHealthy: false, surrealHealthy: false, portsFree: false }))
        .toEqual({ mode: "conflict" });
});
test("partial (surreal up, daemon down) but ports occupied -> spawn-ax-only", () => {
    expect(decideArbitration({ daemonHealthy: false, surrealHealthy: true, portsFree: false }))
        .toEqual({ mode: "spawn-ax-only" });
});
