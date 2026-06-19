export interface HarnessSurfaceInput {
  readonly harness: string;
  readonly serviceName?: string | null;
  readonly originator?: string | null;
  readonly entrypoint?: string | null;
  readonly deploymentProvider?: string | null;
}

export interface HarnessSurfaceClassification {
  readonly surface: string | null;
  readonly entrypoint: string | null;
  readonly deploymentProvider: string | null;
}

const normalize = (value: string | null | undefined): string =>
  value?.trim().toLowerCase().replaceAll("_", "-").replaceAll(" ", "-") ?? "";

const withProvider = (
  classification: HarnessSurfaceClassification,
  explicitProvider: string | null,
): HarnessSurfaceClassification => ({
  ...classification,
  deploymentProvider: explicitProvider ?? classification.deploymentProvider,
});

const codexClassification = (input: HarnessSurfaceInput): HarnessSurfaceClassification => {
  const serviceName = normalize(input.serviceName);
  const originator = normalize(input.originator);
  const entrypoint = normalize(input.entrypoint);

  if (originator.includes("exec") || entrypoint === "exec") {
    return { surface: "exec", entrypoint: "local-noninteractive", deploymentProvider: "local" };
  }

  if (serviceName.includes("app-server")) {
    return { surface: "app-server", entrypoint: "hosted-task", deploymentProvider: "OpenAI hosted" };
  }

  if (serviceName.includes("github")) {
    return { surface: "github-action", entrypoint: "ci", deploymentProvider: "OpenAI hosted" };
  }

  if (serviceName.includes("ide")) {
    return { surface: "ide", entrypoint: "local-interactive", deploymentProvider: "local" };
  }

  return { surface: "cli", entrypoint: "local-interactive", deploymentProvider: "local" };
};

const claudeClassification = (input: HarnessSurfaceInput): HarnessSurfaceClassification => {
  const serviceName = normalize(input.serviceName);
  const entrypoint = normalize(input.entrypoint);

  if (entrypoint === "sdk" || serviceName.includes("sdk")) {
    return { surface: "sdk", entrypoint: "embedded-sdk", deploymentProvider: "local" };
  }

  if (serviceName.includes("desktop")) {
    return { surface: "app", entrypoint: "local-interactive", deploymentProvider: "local" };
  }

  if (serviceName.includes("cloud")) {
    return { surface: "web/cloud", entrypoint: "hosted-task", deploymentProvider: "Anthropic hosted" };
  }

  if (serviceName.includes("web")) {
    return { surface: "web/cloud", entrypoint: "hosted-task", deploymentProvider: "Anthropic hosted" };
  }

  return { surface: "cli", entrypoint: "local-interactive", deploymentProvider: "local" };
};

export const classifyHarnessSurface = (input: HarnessSurfaceInput): HarnessSurfaceClassification => {
  const explicitProvider = input.deploymentProvider?.trim() || null;
  const harness = normalize(input.harness);

  if (harness === "codex") {
    return withProvider(codexClassification(input), explicitProvider);
  }

  if (harness === "claude") {
    return withProvider(claudeClassification(input), explicitProvider);
  }

  return {
    surface: null,
    entrypoint: null,
    deploymentProvider: explicitProvider,
  };
};
