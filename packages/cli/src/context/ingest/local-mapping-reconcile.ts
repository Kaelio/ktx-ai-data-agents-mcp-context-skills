import { ktxLocalStateDbPath } from '../../context/project/local-state-db.js';
import { parseConnectionMappingBootstrap, type LookerMappingBootstrap } from '../../context/project/mappings-yaml-schema.js';
import type { KtxLocalProject } from '../../context/project/project.js';
import { LocalLookerRuntimeStore } from './adapters/looker/local-runtime-store.js';

function lookerMappings(bootstrap: LookerMappingBootstrap) {
  return Object.entries(bootstrap.connectionMappings)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([lookerConnectionName, ktxConnectionId]) => ({ lookerConnectionName, ktxConnectionId }));
}

export async function seedLocalMappingStateFromKtxYaml(project: KtxLocalProject, connectionId: string): Promise<void> {
  const connection = project.config.connections[connectionId];
  if (!connection) {
    return;
  }

  const bootstrap = parseConnectionMappingBootstrap(connectionId, connection);
  if (!bootstrap) {
    return;
  }

  if (bootstrap.adapter === 'metabase') {
    return;
  }

  if (bootstrap.adapter === 'looker') {
    await new LocalLookerRuntimeStore({ dbPath: ktxLocalStateDbPath(project) }).applyYamlBootstrap({
      lookerConnectionId: connectionId,
      mappings: lookerMappings(bootstrap),
    });
  }
}
