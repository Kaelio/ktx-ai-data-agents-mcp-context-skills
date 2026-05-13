export type KtxAgentSlSearchReadinessCode =
  | 'agent_sl_search_missing_project'
  | 'agent_sl_search_no_connections'
  | 'agent_sl_search_unknown_connection'
  | 'agent_sl_search_no_indexed_sources';

export interface KtxAgentSlSearchReadinessDetail {
  code: KtxAgentSlSearchReadinessCode;
  message: string;
  nextSteps: string[];
}

function queryForCommand(query: string | undefined): string {
  const trimmed = query?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : 'revenue';
}

function projectSearchCommand(projectDir: string, query: string | undefined): string {
  return `ktx agent sl list --json --query ${JSON.stringify(queryForCommand(query))} --project-dir ${projectDir}`;
}

function baseNextSteps(projectDir: string, query: string | undefined): string[] {
  return [
    `ktx setup --project-dir ${projectDir}`,
    `ktx status --project-dir ${projectDir}`,
    'ktx ingest run --connection-id <connection> --adapter <adapter>',
    projectSearchCommand(projectDir, query),
  ];
}

export function missingProjectSlSearchReadiness(
  projectDir: string,
  query: string | undefined,
): KtxAgentSlSearchReadinessDetail {
  return {
    code: 'agent_sl_search_missing_project',
    message: `Semantic-layer search needs an initialized KTX project at ${projectDir}.`,
    nextSteps: baseNextSteps(projectDir, query),
  };
}

export function noConnectionsSlSearchReadiness(
  projectDir: string,
  query: string | undefined,
): KtxAgentSlSearchReadinessDetail {
  return {
    code: 'agent_sl_search_no_connections',
    message: `Semantic-layer search found no configured connections in ${projectDir}.`,
    nextSteps: baseNextSteps(projectDir, query),
  };
}

export function missingConnectionSlSearchReadiness(
  projectDir: string,
  connectionId: string,
  query: string | undefined,
): KtxAgentSlSearchReadinessDetail {
  return {
    code: 'agent_sl_search_unknown_connection',
    message: `Semantic-layer search connection "${connectionId}" is not configured in ${projectDir}.`,
    nextSteps: baseNextSteps(projectDir, query),
  };
}

export function noIndexedSourcesSlSearchReadiness(
  projectDir: string,
  query: string | undefined,
): KtxAgentSlSearchReadinessDetail {
  return {
    code: 'agent_sl_search_no_indexed_sources',
    message: `Semantic-layer search found no indexed semantic-layer sources in ${projectDir}.`,
    nextSteps: baseNextSteps(projectDir, query),
  };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorPath(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('path' in error)) {
    return undefined;
  }
  const path = (error as { path?: unknown }).path;
  return typeof path === 'string' ? path : undefined;
}

export function isMissingProjectConfigError(error: unknown): boolean {
  return errorCode(error) === 'ENOENT' && (errorPath(error)?.endsWith('ktx.yaml') ?? false);
}
