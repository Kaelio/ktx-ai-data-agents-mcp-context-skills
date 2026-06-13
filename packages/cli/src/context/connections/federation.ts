import type { KtxProjectConnectionConfig } from '../project/config.js';

/** Stable id for the runtime-derived federated connection. Never written to ktx.yaml. */
export const FEDERATED_CONNECTION_ID = '_ktx_federated';

/**
 * Maps each attach-compatible driver to the DuckDB extension that attaches it.
 * The keys are the single source of truth for federation membership: a driver
 * participates iff it appears here.
 */
const ATTACH_TYPE_BY_DRIVER: Record<string, string> = {
  postgres: 'postgres',
  mysql: 'mysql',
  sqlite: 'sqlite',
};

export function attachTypeForDriver(driver: string): string {
  const type = ATTACH_TYPE_BY_DRIVER[driver.toLowerCase()];
  if (!type) {
    throw new Error(`Driver "${driver}" cannot be attached by DuckDB federation.`);
  }
  return type;
}

export interface FederatedMember {
  connectionId: string;
  driver: string;
  projectDir: string;
  connection: KtxProjectConnectionConfig;
}

export interface FederatedConnectionDescriptor {
  id: typeof FEDERATED_CONNECTION_ID;
  driver: 'duckdb';
  members: FederatedMember[];
}

/**
 * Derives a virtual federated connection when a project declares 2+
 * attach-compatible databases. Returns null otherwise — single-DB and
 * incompatible projects are unaffected.
 */
export function deriveFederatedConnection(
  connections: Record<string, KtxProjectConnectionConfig>,
  projectDir: string,
): FederatedConnectionDescriptor | null {
  const members: FederatedMember[] = Object.entries(connections)
    .filter(([, config]) => config.driver.toLowerCase() in ATTACH_TYPE_BY_DRIVER)
    .map(([connectionId, config]) => ({
      connectionId,
      driver: config.driver.toLowerCase(),
      projectDir,
      connection: config,
    }));
  if (members.length < 2) {
    return null;
  }
  return { id: FEDERATED_CONNECTION_ID, driver: 'duckdb', members };
}

export interface FederatedConnectionListing {
  id: typeof FEDERATED_CONNECTION_ID;
  driver: 'duckdb';
  members: string[];
  hint: string;
}

/**
 * Listing-facing view of the virtual federated connection for `ktx connection`
 * and MCP `connection_list`. Derived from the same declared state as
 * deriveFederatedConnection, so both surfaces describe one connection.
 */
export function federatedConnectionListing(
  connections: Record<string, KtxProjectConnectionConfig>,
  projectDir: string,
): FederatedConnectionListing | null {
  const descriptor = deriveFederatedConnection(connections, projectDir);
  if (!descriptor) {
    return null;
  }
  return {
    id: FEDERATED_CONNECTION_ID,
    driver: 'duckdb',
    members: descriptor.members.map((member) => member.connectionId),
    hint: 'Cross-database queries run here. Name tables connectionId.schema.table (or connectionId.table for sqlite).',
  };
}
