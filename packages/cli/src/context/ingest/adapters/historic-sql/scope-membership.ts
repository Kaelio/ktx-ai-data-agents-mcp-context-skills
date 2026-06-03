import { tableRefKey, tableRefSet } from '../../../scan/table-ref.js';
import type { KtxTableRef } from '../../../scan/types.js';

export interface QueryHistoryScopeMembershipConfig {
  enabledTables: readonly KtxTableRef[];
  enabledSchemas: readonly string[];
}

function schemaNameForRef(ref: KtxTableRef): string | null {
  return ref.db && ref.db.length > 0 ? ref.db : null;
}

function schemaNamesFromConfig(enabledSchemas: readonly string[]): Set<string> {
  return new Set(enabledSchemas.filter((schema) => schema !== '*'));
}

export function isQueryHistoryScopeFloorDisabled(config: QueryHistoryScopeMembershipConfig): boolean {
  return config.enabledSchemas.includes('*');
}

export function shouldFailOpenQueryHistoryScope(config: QueryHistoryScopeMembershipConfig): boolean {
  return (
    config.enabledTables.length === 0 &&
    !isQueryHistoryScopeFloorDisabled(config) &&
    config.enabledSchemas.length === 0
  );
}

export function includedQueryHistoryTableRefs(
  tablesTouched: readonly KtxTableRef[],
  config: QueryHistoryScopeMembershipConfig,
): KtxTableRef[] {
  if (config.enabledTables.length > 0) {
    const enabled = tableRefSet(config.enabledTables);
    return tablesTouched.filter((ref) => enabled.has(tableRefKey(ref)));
  }
  if (isQueryHistoryScopeFloorDisabled(config) || shouldFailOpenQueryHistoryScope(config)) {
    return [...tablesTouched];
  }
  const schemas = schemaNamesFromConfig(config.enabledSchemas);
  return tablesTouched.filter((ref) => {
    const schema = schemaNameForRef(ref);
    return schema !== null && schemas.has(schema);
  });
}
