import type { KtxSchemaSnapshot } from '../../../scan/types.js';
import type { KtxTableRefKey } from '../../../scan/table-ref.js';

export interface LiveDatabaseIntrospectionOptions {
  tableScope?: ReadonlySet<KtxTableRefKey>;
}

export interface LiveDatabaseIntrospectionPort {
  extractSchema(connectionId: string, options?: LiveDatabaseIntrospectionOptions): Promise<KtxSchemaSnapshot>;
}

export interface LiveDatabaseSourceAdapterDeps {
  introspection: LiveDatabaseIntrospectionPort;
  now?: () => Date;
  resolveTableScope?: (connectionId: string) => ReadonlySet<KtxTableRefKey> | undefined;
}
