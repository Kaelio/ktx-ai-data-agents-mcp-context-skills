import type { KtxLocalProject, KtxProjectConnectionConfig } from '../../../project/index.js';
import { ktxLocalStateDbPath } from '../../../project/index.js';
import { resolveKtxConfigReference } from '../../../core/config-reference.js';
import {
  DEFAULT_METABASE_CLIENT_CONFIG,
  DefaultMetabaseConnectionClientFactory,
  type MetabaseClientLogger,
} from './client.js';
import {
  IngestMetabaseClientFactory,
  type MetabaseClientConfig,
  type MetabaseClientRuntimeConfig,
} from './client-port.js';
import type { MetabaseFetchLogger } from './fetch.js';
import { KtxYamlMetabaseSourceStateReader, LocalMetabaseDiscoveryCache } from './local-source-state-store.js';
import { MetabaseSourceAdapter } from './metabase.adapter.js';

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function hasNetworkProxy(connection: KtxProjectConnectionConfig): boolean {
  return connection.networkProxy != null || connection.network_proxy != null;
}

export function metabaseRuntimeConfigFromLocalConnection(
  connectionId: string,
  connection: KtxProjectConnectionConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): MetabaseClientRuntimeConfig {
  if (!connection || String(connection.driver).toLowerCase() !== 'metabase') {
    throw new Error(`Connection "${connectionId}" is not a Metabase connection`);
  }
  if (hasNetworkProxy(connection)) {
    throw new Error(
      `Standalone KTX does not support proxy-bearing Metabase connections yet. Use hosted Metabase ingest for "${connectionId}" until the KTX Metabase proxy support spec lands.`,
    );
  }

  const apiUrl = stringField(connection.api_url) ?? stringField(connection.apiUrl) ?? stringField(connection.url);
  const literalApiKey = stringField(connection.api_key) ?? stringField(connection.apiKey);
  const apiKeyRef = stringField(connection.api_key_ref) ?? stringField(connection.apiKeyRef);
  const apiKey = literalApiKey ?? (apiKeyRef ? resolveKtxConfigReference(apiKeyRef, env) : null);

  if (!apiUrl) {
    throw new Error(`Connection "${connectionId}" is missing metabase api_url`);
  }
  if (!apiKey) {
    throw new Error(`Connection "${connectionId}" is missing metabase api_key or api_key_ref`);
  }

  return { apiUrl, apiKey };
}

interface CreateLocalMetabaseSourceAdapterOptions {
  env?: NodeJS.ProcessEnv;
  defaultClientConfig?: MetabaseClientConfig;
  logger?: MetabaseClientLogger & MetabaseFetchLogger;
}

export function createLocalMetabaseSourceAdapter(
  project: KtxLocalProject,
  options: CreateLocalMetabaseSourceAdapterOptions = {},
): MetabaseSourceAdapter {
  const discoveryCache = new LocalMetabaseDiscoveryCache({ dbPath: ktxLocalStateDbPath(project) });
  const sourceStateReader = new KtxYamlMetabaseSourceStateReader(project, { discoveryCache });
  const connectionFactory = new DefaultMetabaseConnectionClientFactory(
    (metabaseConnectionId) =>
      metabaseRuntimeConfigFromLocalConnection(
        metabaseConnectionId,
        project.config.connections[metabaseConnectionId],
        options.env,
      ),
    options.defaultClientConfig ?? DEFAULT_METABASE_CLIENT_CONFIG,
    options.logger,
  );
  return new MetabaseSourceAdapter({
    clientFactory: new IngestMetabaseClientFactory(connectionFactory),
    sourceStateReader,
    ...(options.logger ? { logger: options.logger } : {}),
  });
}
