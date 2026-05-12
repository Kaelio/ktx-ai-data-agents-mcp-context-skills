import type { KtxLocalProject, KtxProjectConnectionConfig } from '../../../project/index.js';
import type { LookerClientLogger } from './client.js';
import {
  DefaultLookerClientFactory,
  DefaultLookerConnectionClientFactory,
  type LookerCredentialResolver,
} from './factory.js';
import { LookerSourceAdapter } from './looker.adapter.js';

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolveEnvReference(ref: string, env: NodeJS.ProcessEnv): string | null {
  if (!ref.startsWith('env:')) {
    return null;
  }
  return stringField(env[ref.slice('env:'.length)]);
}

export function lookerCredentialsFromLocalConnection(
  connectionId: string,
  connection: KtxProjectConnectionConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!connection || String(connection.driver).toLowerCase() !== 'looker') {
    throw new Error(`Connection "${connectionId}" is not a Looker connection`);
  }
  const baseUrl = stringField(connection.base_url) ?? stringField(connection.baseUrl) ?? stringField(connection.url);
  const clientId = stringField(connection.client_id) ?? stringField(connection.clientId);
  const clientSecret =
    stringField(connection.client_secret) ??
    stringField(connection.clientSecret) ??
    (stringField(connection.client_secret_ref) ? resolveEnvReference(String(connection.client_secret_ref), env) : null) ??
    (stringField(connection.clientSecretRef) ? resolveEnvReference(String(connection.clientSecretRef), env) : null);

  if (!baseUrl) {
    throw new Error(`Connection "${connectionId}" is missing Looker base_url`);
  }
  if (!clientId) {
    throw new Error(`Connection "${connectionId}" is missing Looker client_id`);
  }
  if (!clientSecret) {
    throw new Error(`Connection "${connectionId}" is missing Looker client_secret or client_secret_ref`);
  }
  return { base_url: baseUrl, client_id: clientId, client_secret: clientSecret };
}

export function createLocalLookerCredentialResolver(
  project: KtxLocalProject,
  env: NodeJS.ProcessEnv = process.env,
): LookerCredentialResolver {
  return {
    async resolve(lookerConnectionId) {
      return lookerCredentialsFromLocalConnection(lookerConnectionId, project.config.connections[lookerConnectionId], env);
    },
  };
}

export function createLocalLookerSourceAdapter(
  project: KtxLocalProject,
  env: NodeJS.ProcessEnv = process.env,
  logger?: LookerClientLogger,
): LookerSourceAdapter {
  const connectionFactory = new DefaultLookerConnectionClientFactory(createLocalLookerCredentialResolver(project, env), {
    ...(logger ? { logger } : {}),
  });
  return new LookerSourceAdapter({
    clientFactory: new DefaultLookerClientFactory(connectionFactory),
  });
}
