import type { FetchContext } from '../../types.js';
import { LookerClient, type LookerClientDeps, type LookerConnectionParams } from './client.js';
import type { LookerClientFactory, LookerRuntimeClient } from './fetch.js';
import type { LookerPullConfig } from './types.js';

export interface LookerCredentialResolver {
  resolve(lookerConnectionId: string): Promise<LookerConnectionParams>;
}

/** @internal */
export interface LookerConnectionClientFactory {
  createClient(lookerConnectionId: string): Promise<LookerRuntimeClient>;
}

export class DefaultLookerConnectionClientFactory implements LookerConnectionClientFactory {
  constructor(
    private readonly resolver: LookerCredentialResolver,
    private readonly deps: LookerClientDeps = {},
  ) {}

  async createClient(lookerConnectionId: string): Promise<LookerRuntimeClient> {
    return this.createLookerClient(lookerConnectionId);
  }

  /**
   * Like {@link createClient} but preserves the concrete {@link LookerClient}
   * type, so callers that need methods outside the `LookerRuntimeClient`
   * contract (e.g. `listLookerConnections`, `testConnection`) keep them without
   * a cast.
   */
  async createLookerClient(lookerConnectionId: string): Promise<LookerClient> {
    const credentials = await this.resolver.resolve(lookerConnectionId);
    return new LookerClient(credentials, this.deps);
  }
}

/** @internal */
export class DefaultLookerClientFactory implements LookerClientFactory {
  constructor(private readonly inner: LookerConnectionClientFactory) {}

  async createClient(config: LookerPullConfig, ctx: FetchContext): Promise<LookerRuntimeClient> {
    return this.inner.createClient(config.lookerConnectionId ?? ctx.connectionId);
  }
}
