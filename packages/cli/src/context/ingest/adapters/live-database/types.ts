import type { KtxSchemaSnapshot } from '../../../scan/types.js';

export interface LiveDatabaseIntrospectionPort {
  extractSchema(connectionId: string): Promise<KtxSchemaSnapshot>;
}

export interface LiveDatabaseSourceAdapterDeps {
  introspection: LiveDatabaseIntrospectionPort;
  now?: () => Date;
}
