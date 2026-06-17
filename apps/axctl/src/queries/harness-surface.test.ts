import { describe, expect, test } from "bun:test";
import { classifyHarnessSurface } from "./harness-surface.ts";

describe("classifyHarnessSurface", () => {
  test("classifies Codex exec as local noninteractive execution", () => {
    expect(classifyHarnessSurface({ harness: "codex", originator: "codex_exec" })).toEqual({
      surface: "exec",
      entrypoint: "local-noninteractive",
      deploymentProvider: "local",
    });
  });

  test("classifies Codex app server as an OpenAI hosted task", () => {
    expect(classifyHarnessSurface({ harness: "codex", serviceName: "codex_app_server" })).toEqual({
      surface: "app-server",
      entrypoint: "hosted-task",
      deploymentProvider: "OpenAI hosted",
    });
  });

  test("classifies Codex GitHub Action as hosted CI", () => {
    expect(classifyHarnessSurface({ harness: "codex", serviceName: "codex_github_action" })).toEqual({
      surface: "github-action",
      entrypoint: "ci",
      deploymentProvider: "OpenAI hosted",
    });
  });

  test("classifies Codex GitHub service names by substring", () => {
    expect(classifyHarnessSurface({ harness: "codex", serviceName: "github" })).toEqual({
      surface: "github-action",
      entrypoint: "ci",
      deploymentProvider: "OpenAI hosted",
    });
  });

  test("classifies Codex IDE as local interactive", () => {
    expect(classifyHarnessSurface({ harness: "codex", serviceName: "codex_ide" })).toEqual({
      surface: "ide",
      entrypoint: "local-interactive",
      deploymentProvider: "local",
    });
  });

  test("classifies default Codex as local interactive CLI", () => {
    expect(classifyHarnessSurface({ harness: "codex" })).toEqual({
      surface: "cli",
      entrypoint: "local-interactive",
      deploymentProvider: "local",
    });
  });

  test("classifies Claude SDK as an embedded local SDK", () => {
    expect(classifyHarnessSurface({ harness: "claude", entrypoint: "sdk" })).toEqual({
      surface: "sdk",
      entrypoint: "embedded-sdk",
      deploymentProvider: "local",
    });
  });

  test("classifies Claude SDK service as an embedded local SDK", () => {
    expect(classifyHarnessSurface({ harness: "claude", serviceName: "claude_sdk" })).toEqual({
      surface: "sdk",
      entrypoint: "embedded-sdk",
      deploymentProvider: "local",
    });
  });

  test("classifies Claude desktop service as local interactive app", () => {
    expect(classifyHarnessSurface({ harness: "claude", serviceName: "claude_desktop" })).toEqual({
      surface: "app",
      entrypoint: "local-interactive",
      deploymentProvider: "local",
    });
  });

  test("classifies Claude web service as Anthropic hosted task", () => {
    expect(classifyHarnessSurface({ harness: "claude", serviceName: "claude_web" })).toEqual({
      surface: "web/cloud",
      entrypoint: "hosted-task",
      deploymentProvider: "Anthropic hosted",
    });
  });

  test("classifies Claude cloud service as Anthropic hosted task", () => {
    expect(classifyHarnessSurface({ harness: "claude", serviceName: "claude_cloud" })).toEqual({
      surface: "web/cloud",
      entrypoint: "hosted-task",
      deploymentProvider: "Anthropic hosted",
    });
  });

  test("classifies default Claude as local interactive CLI", () => {
    expect(classifyHarnessSurface({ harness: "claude" })).toEqual({
      surface: "cli",
      entrypoint: "local-interactive",
      deploymentProvider: "local",
    });
  });

  test("leaves unknown harness surface and entrypoint null", () => {
    expect(
      classifyHarnessSurface({
        harness: "mystery",
        deploymentProvider: "partner hosted",
      }),
    ).toEqual({
      surface: null,
      entrypoint: null,
      deploymentProvider: "partner hosted",
    });
  });

  test("preserves an explicit deployment provider", () => {
    expect(
      classifyHarnessSurface({
        harness: "codex",
        originator: "codex_exec",
        deploymentProvider: "self-hosted runner",
      }),
    ).toEqual({
      surface: "exec",
      entrypoint: "local-noninteractive",
      deploymentProvider: "self-hosted runner",
    });
  });
});
