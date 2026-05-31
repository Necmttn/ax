export const SUPPORTED_SHARE_SCHEMA_VERSION = 1;

export type ShareArtifact = {
  readonly schema_version: typeof SUPPORTED_SHARE_SCHEMA_VERSION;
  readonly exported_at: string;
  readonly ax_version?: string;
  readonly session: {
    readonly id: string;
    readonly source: string;
    readonly model?: string;
    readonly project?: string;
    readonly repository?: string;
    readonly started_at?: string;
    readonly ended_at?: string;
    readonly summary?: string;
  };
  readonly stats: {
    readonly turns: number;
    readonly tool_calls: number;
    readonly files_changed: number;
    readonly skills_used: number;
    readonly failures: number;
  };
  readonly turns?: ReadonlyArray<{
    readonly id: string;
    readonly seq: number;
    readonly ts?: string;
    readonly role: string;
    readonly message_kind?: string;
    readonly intent_kind?: string;
    readonly text: string;
    readonly text_excerpt?: string;
    readonly has_tool_use?: boolean;
    readonly has_error?: boolean;
  }>;
  readonly timeline: ReadonlyArray<{
    readonly id: string;
    readonly ts?: string;
    readonly kind: string;
    readonly actor?: string;
    readonly title: string;
    readonly summary?: string;
  }>;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly lang?: string;
    readonly role?: string;
    readonly additions?: number;
    readonly deletions?: number;
  }>;
  readonly graph: {
    readonly nodes: ReadonlyArray<unknown>;
    readonly edges: ReadonlyArray<unknown>;
  };
  readonly derived?: {
    readonly working_style?: ReadonlyArray<string>;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function gistApiUrl(gistId: string): string {
  return `https://api.github.com/gists/${encodeURIComponent(gistId)}`;
}

export function gistOwnerMatches(value: unknown, owner: string): boolean {
  if (!isRecord(value) || !isRecord(value.owner)) {
    return false;
  }

  const { login } = value.owner;
  return (
    typeof login === "string" &&
    login.localeCompare(owner, undefined, { sensitivity: "accent" }) === 0
  );
}

export function rawSessionFileUrlFromGist(value: unknown): string {
  if (!isRecord(value)) {
    throw new Error("Invalid Gist response");
  }

  const { files } = value;
  if (!isRecord(files)) {
    throw new Error("Gist response has no files");
  }

  const sessionFile = files["ax-session.json"];
  if (!isRecord(sessionFile)) {
    throw new Error("Gist does not contain ax-session.json");
  }

  const { raw_url: rawUrl } = sessionFile;
  if (typeof rawUrl !== "string") {
    throw new Error("ax-session.json has no raw_url");
  }

  return rawUrl;
}

export function validateShareArtifact(value: unknown): ShareArtifact {
  if (!isRecord(value)) {
    throw new Error("Invalid session share artifact");
  }

  if (value.schema_version !== SUPPORTED_SHARE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported session share schema: ${String(value.schema_version)}`,
    );
  }

  const { session, stats, turns, timeline, files, graph, derived } = value;
  if (
    typeof value.exported_at !== "string" ||
    !isRecord(session) ||
    typeof session.id !== "string" ||
    typeof session.source !== "string" ||
    !isOptionalString(session.model) ||
    !isOptionalString(session.project) ||
    !isOptionalString(session.repository) ||
    !isOptionalString(session.started_at) ||
    !isOptionalString(session.ended_at) ||
    !isOptionalString(session.summary) ||
    !isRecord(stats) ||
    !isFiniteNumber(stats.turns) ||
    !isFiniteNumber(stats.tool_calls) ||
    !isFiniteNumber(stats.files_changed) ||
    !isFiniteNumber(stats.skills_used) ||
    !isFiniteNumber(stats.failures) ||
    !isValidShareTurns(turns) ||
    !Array.isArray(timeline) ||
    !timeline.every(isShareTimelineItem) ||
    !Array.isArray(files) ||
    !files.every(isShareFileItem) ||
    !isRecord(graph) ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges) ||
    !isValidDerived(derived)
  ) {
    throw new Error("Invalid session share artifact");
  }

  return value as ShareArtifact;
}

function isValidShareTurns(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  return Array.isArray(value) && value.every(isShareTurnItem);
}

function isShareTurnItem(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    isFiniteNumber(value.seq) &&
    typeof value.role === "string" &&
    typeof value.text === "string" &&
    isOptionalString(value.ts) &&
    isOptionalString(value.message_kind) &&
    isOptionalString(value.intent_kind) &&
    isOptionalString(value.text_excerpt) &&
    (value.has_tool_use === undefined || typeof value.has_tool_use === "boolean") &&
    (value.has_error === undefined || typeof value.has_error === "boolean")
  );
}

function isShareTimelineItem(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.kind === "string" &&
    typeof value.title === "string" &&
    isOptionalString(value.summary) &&
    isOptionalString(value.ts) &&
    isOptionalString(value.actor)
  );
}

function isShareFileItem(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.path === "string" &&
    isOptionalString(value.role) &&
    isOptionalString(value.lang) &&
    isOptionalNumber(value.additions) &&
    isOptionalNumber(value.deletions)
  );
}

function isValidDerived(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }

  if (!isRecord(value)) {
    return false;
  }

  const { working_style: workingStyle } = value;
  return (
    workingStyle === undefined ||
    (Array.isArray(workingStyle) &&
      workingStyle.every((item) => typeof item === "string"))
  );
}
