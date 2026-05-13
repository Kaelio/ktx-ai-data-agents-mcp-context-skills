import { writeFile } from 'node:fs/promises';
import {
  type KtxLocalProject,
  type KtxProjectConnectionConfig,
  loadKtxProject,
  serializeKtxProjectConfig,
} from '@ktx/context/project';
import {
  type KtxDatabaseContextDepth,
  databaseContextDepth,
  deepReadinessGaps,
  isDatabaseDriver,
  normalizeConnectionDriver,
  recommendedDatabaseContextDepth,
  withDatabaseContextDepth,
} from './ingest-depth.js';
import type { KtxSetupPromptOption } from './setup-prompts.js';

export interface KtxSetupDatabaseContextDepthArgs {
  inputMode: 'auto' | 'disabled';
}

export interface KtxSetupDatabaseContextDepthPromptAdapter {
  select(options: { message: string; options: KtxSetupPromptOption[] }): Promise<string>;
}

function databaseConnectionsNeedingDepth(project: KtxLocalProject): string[] {
  return Object.entries(project.config.connections)
    .filter(([, connection]) => isDatabaseDriver(normalizeConnectionDriver(connection)))
    .filter(([, connection]) => databaseContextDepth(connection) === undefined)
    .map(([connectionId]) => connectionId)
    .sort((left, right) => left.localeCompare(right));
}

async function chooseSetupDatabaseContextDepth(input: {
  project: KtxLocalProject;
  args: KtxSetupDatabaseContextDepthArgs;
  prompts: KtxSetupDatabaseContextDepthPromptAdapter;
}): Promise<KtxDatabaseContextDepth | 'back'> {
  const recommended = recommendedDatabaseContextDepth(input.project.config);
  if (input.args.inputMode === 'disabled') {
    return recommended;
  }

  const deepReady = deepReadinessGaps(input.project.config).length === 0;
  const options =
    recommended === 'deep'
      ? [
          { value: 'deep', label: 'Deep: AI descriptions, embeddings, relationships, slower' },
          { value: 'fast', label: 'Fast: schema only, no AI, quickest' },
          { value: 'back', label: 'Back' },
        ]
      : [
          { value: 'fast', label: 'Fast: schema only, no AI, quickest' },
          { value: 'deep', label: 'Deep: AI descriptions, embeddings, relationships, slower' },
          { value: 'back', label: 'Back' },
        ];

  const choice = await input.prompts.select({
    message:
      'How much database context should KTX build?\n\n' +
      (deepReady
        ? 'Deep is available because model, embedding, and scan enrichment are configured.'
        : 'Fast is recommended because model, embedding, or scan enrichment is not configured.'),
    options,
  });
  if (choice === 'back') {
    return 'back';
  }
  if (choice === 'fast' || choice === 'deep') {
    return choice;
  }
  return recommended;
}

async function writeDatabaseContextDepths(
  project: KtxLocalProject,
  connectionIds: string[],
  depth: KtxDatabaseContextDepth,
): Promise<KtxLocalProject> {
  if (connectionIds.length === 0) {
    return project;
  }
  const nextConnections = { ...project.config.connections };
  for (const connectionId of connectionIds) {
    const connection = nextConnections[connectionId];
    if (connection) {
      nextConnections[connectionId] = withDatabaseContextDepth(connection, depth);
    }
  }
  const nextConfig = { ...project.config, connections: nextConnections };
  await writeFile(project.configPath, serializeKtxProjectConfig(nextConfig), 'utf-8');
  return await loadKtxProject({ projectDir: project.projectDir });
}

export async function ensureSetupDatabaseContextDepths(input: {
  project: KtxLocalProject;
  args: KtxSetupDatabaseContextDepthArgs;
  prompts: KtxSetupDatabaseContextDepthPromptAdapter;
}): Promise<KtxLocalProject | 'back'> {
  const missingDepthConnectionIds = databaseConnectionsNeedingDepth(input.project);
  if (missingDepthConnectionIds.length === 0) {
    return input.project;
  }

  const depth = await chooseSetupDatabaseContextDepth(input);
  if (depth === 'back') {
    return 'back';
  }
  return await writeDatabaseContextDepths(input.project, missingDepthConnectionIds, depth);
}

export async function applySetupDatabaseContextDepth(input: {
  project: KtxLocalProject;
  connection: KtxProjectConnectionConfig;
  args: KtxSetupDatabaseContextDepthArgs;
  prompts: KtxSetupDatabaseContextDepthPromptAdapter;
}): Promise<KtxProjectConnectionConfig | 'back'> {
  if (
    !isDatabaseDriver(normalizeConnectionDriver(input.connection)) ||
    databaseContextDepth(input.connection) !== undefined
  ) {
    return input.connection;
  }

  const depth = await chooseSetupDatabaseContextDepth(input);
  if (depth === 'back') {
    return 'back';
  }
  return withDatabaseContextDepth(input.connection, depth);
}
