import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { KtxProjectConfig } from '../context/project/config.js';
import { resolveProjectRuntimeRequirements } from '../runtime-requirements.js';
import { isDemoConnection } from './demo-detect.js';

async function hasFileWithExtension(dir: string, extensions: Set<string>): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && (await hasFileWithExtension(path, extensions))) {
      return true;
    }
    if (entry.isFile() && extensions.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      return true;
    }
  }
  return false;
}

async function hasFileNamed(dir: string, filenames: Set<string>): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  return entries.some((entry) => entry.isFile() && filenames.has(entry.name));
}

async function hasMcpConfig(projectDir: string): Promise<boolean> {
  return (
    (await hasFileWithExtension(join(projectDir, '.ktx'), new Set(['.json']))) ||
    (await hasFileWithExtension(join(projectDir, '.cursor'), new Set(['.json']))) ||
    (await hasFileNamed(projectDir, new Set(['.mcp.json'])))
  );
}

export async function buildProjectStackSnapshotFields(input: {
  projectDir: string;
  config: KtxProjectConfig;
}) {
  const connectors = Object.entries(input.config.connections).map(([connectionId, connection]) => ({
    driver: String(connection.driver ?? 'unknown').trim().toLowerCase() || 'unknown',
    isDemo: isDemoConnection(connectionId, connection),
  }));

  const runtimeRequirements = resolveProjectRuntimeRequirements(input.config, {
    env: process.env,
  });

  return {
    connectors,
    connectionCount: connectors.length,
    hasSl: await hasFileWithExtension(join(input.projectDir, 'semantic-layer'), new Set(['.yaml', '.yml'])),
    hasWiki: await hasFileWithExtension(join(input.projectDir, 'wiki'), new Set(['.md', '.mdx'])),
    hasMcp: await hasMcpConfig(input.projectDir),
    hasManagedRuntime: runtimeRequirements.features.length > 0,
  };
}
