import { resolveKtxConfigReference } from '../context/core/config-reference.js';
import { loadKtxProject, type KtxLocalProject } from '../context/project/project.js';

const SENSITIVE_KEY =
  /(password|secret|token|api[_-]?key|auth[_-]?token|auth_token_ref|private[_-]?key|passphrase|credential|authorization|url)$/i;

type TelemetryRedactionProject = Pick<KtxLocalProject, 'config' | 'projectDir'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addSecret(values: string[], value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed && !values.includes(trimmed)) {
    values.push(trimmed);
  }
}

function tryResolve(value: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    return resolveKtxConfigReference(value, env);
  } catch {
    return undefined;
  }
}

function addUrlCredentials(values: string[], value: string): void {
  try {
    const parsed = new URL(value);
    addSecret(values, parsed.password ? decodeURIComponent(parsed.password) : undefined);
    addSecret(values, parsed.username ? decodeURIComponent(parsed.username) : undefined);
  } catch {
    return;
  }
}

function collectFromRecord(input: unknown, env: NodeJS.ProcessEnv, values: string[]): void {
  if (Array.isArray(input)) {
    for (const item of input) {
      collectFromRecord(item, env, values);
    }
    return;
  }

  if (!isRecord(input)) {
    return;
  }

  for (const [key, raw] of Object.entries(input)) {
    if (isRecord(raw) || Array.isArray(raw)) {
      collectFromRecord(raw, env, values);
      continue;
    }
    if (typeof raw !== 'string' || !SENSITIVE_KEY.test(key)) {
      continue;
    }
    const resolved = tryResolve(raw, env);
    addSecret(values, resolved);
    if (resolved) {
      addUrlCredentials(values, resolved);
    }
  }
}

function collectLlmSecrets(project: TelemetryRedactionProject, env: NodeJS.ProcessEnv, values: string[]): void {
  collectFromRecord(project.config.llm.provider, env, values);
}

function collectEmbeddingSecrets(project: TelemetryRedactionProject, env: NodeJS.ProcessEnv, values: string[]): void {
  collectFromRecord(project.config.ingest.embeddings, env, values);
  collectFromRecord(project.config.scan.enrichment.embeddings, env, values);
}

function collectConnectionSecrets(
  project: TelemetryRedactionProject,
  connectionId: string | undefined,
  env: NodeJS.ProcessEnv,
  values: string[],
): void {
  if (!connectionId) {
    return;
  }
  collectFromRecord(project.config.connections[connectionId], env, values);
}

export async function collectTelemetryRedactionSecrets(input: {
  project?: TelemetryRedactionProject;
  projectDir?: string;
  connectionId?: string;
  includeLlm?: boolean;
  includeEmbeddings?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const env = input.env ?? process.env;
  let project = input.project;
  if (!project && input.projectDir) {
    try {
      project = await loadKtxProject({ projectDir: input.projectDir });
    } catch {
      project = undefined;
    }
  }
  if (!project) {
    return [];
  }

  const values: string[] = [];
  if (input.includeLlm) {
    collectLlmSecrets(project, env, values);
  }
  if (input.includeEmbeddings) {
    collectEmbeddingSecrets(project, env, values);
  }
  collectConnectionSecrets(project, input.connectionId, env, values);
  return values;
}
