import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { KtxLocalProject } from '../context/project/project.js';
import { resolveKtxProjectDir } from '../project-resolver.js';
import type { CompletionProviders } from './complete-engine.js';

/** Extract an option value from already-typed tokens (`--flag value` or `--flag=value`). */
function extractOptionValue(tokens: string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === flag) {
      const next = tokens[index + 1];
      if (next !== undefined && !next.startsWith('-')) {
        return next;
      }
    } else if (token.startsWith(prefix)) {
      return token.slice(prefix.length);
    }
  }
  return undefined;
}

/**
 * Resolve and load the project the user is completing against. Honors a
 * `--project-dir` typed on the line, then `KTX_PROJECT_DIR`, then the nearest
 * `ktx.yaml`. Returns null (no completions) when there is no project, without
 * creating any files.
 */
async function loadCompletionProject(typedTokens: string[]): Promise<KtxLocalProject | null> {
  const explicitProjectDir = extractOptionValue(typedTokens, '--project-dir');
  const projectDir = resolveKtxProjectDir(explicitProjectDir !== undefined ? { explicitProjectDir } : {});
  if (!existsSync(join(projectDir, 'ktx.yaml'))) {
    return null;
  }
  const { loadKtxProject } = await import('../context/project/project.js');
  return loadKtxProject({ projectDir });
}

async function sourceNames(typedTokens: string[]): Promise<string[]> {
  const project = await loadCompletionProject(typedTokens);
  if (!project) {
    return [];
  }
  const connectionId = extractOptionValue(typedTokens, '--connection-id');
  const { listLocalSlSources } = await import('../context/sl/local-sl.js');
  const summaries = await listLocalSlSources(project, connectionId !== undefined ? { connectionId } : {});
  return summaries.map((summary) => summary.name);
}

async function wikiPageKeys(typedTokens: string[]): Promise<string[]> {
  const project = await loadCompletionProject(typedTokens);
  if (!project) {
    return [];
  }
  const userId = extractOptionValue(typedTokens, '--user-id');
  const { listLocalKnowledgePageKeys } = await import('../context/wiki/local-knowledge.js');
  return listLocalKnowledgePageKeys(project, userId !== undefined ? { userId } : {});
}

async function connectionIds(typedTokens: string[]): Promise<string[]> {
  const project = await loadCompletionProject(typedTokens);
  if (!project) {
    return [];
  }
  return Object.keys(project.config.connections).sort();
}

/**
 * Project-backed completion providers. Every entry swallows its own errors so a
 * failed lookup never breaks the shell — completion degrades to commands/flags.
 */
export function createProjectCompletionProviders(): CompletionProviders {
  return {
    async positionalCandidates(commandPath, typedTokens) {
      try {
        const key = commandPath.join(' ');
        if (key === 'sl read' || key === 'sl validate') {
          return await sourceNames(typedTokens);
        }
        if (key === 'wiki read') {
          return await wikiPageKeys(typedTokens);
        }
        if (key === 'connection test' || key === 'ingest') {
          return await connectionIds(typedTokens);
        }
        return [];
      } catch {
        return [];
      }
    },
    async optionValueCandidates(_commandPath, optionFlag, typedTokens) {
      try {
        if (optionFlag === '--connection-id' || optionFlag === '--connection') {
          return await connectionIds(typedTokens);
        }
        return [];
      } catch {
        return [];
      }
    },
  };
}
