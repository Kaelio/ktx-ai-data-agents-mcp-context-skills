import type { KtxProjectConnectionConfig } from '../project/config.js';

/** Stable id for the runtime-derived federated connection. Never written to ktx.yaml. */
export const FEDERATED_CONNECTION_ID = '_ktx_federated';

/** Drivers DuckDB can ATTACH live with first-party extensions. */
const ATTACH_COMPATIBLE_DRIVERS = new Set(['postgres', 'mysql', 'sqlite']);

export interface FederatedMember {
  connectionId: string;
  driver: string;
  config: KtxProjectConnectionConfig;
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
): FederatedConnectionDescriptor | null {
  const members: FederatedMember[] = [];
  for (const [connectionId, config] of Object.entries(connections)) {
    const driver = config.driver.toLowerCase();
    if (ATTACH_COMPATIBLE_DRIVERS.has(driver)) {
      members.push({ connectionId, driver, config });
    }
  }
  if (members.length < 2) {
    return null;
  }
  return { id: FEDERATED_CONNECTION_ID, driver: 'duckdb', members };
}
