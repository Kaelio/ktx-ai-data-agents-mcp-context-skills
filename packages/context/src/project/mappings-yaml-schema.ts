import * as z from 'zod';

const metabaseSyncModeSchema = z.enum(['ALL', 'ONLY', 'EXCEPT']);
const positiveIntegerValueSchema = z.number().int().positive();
const stringTargetSchema = z.string().min(1).nullable();

const metabaseSelectionsSchema = z
  .object({
    collections: z.array(positiveIntegerValueSchema).default([]),
    items: z.array(positiveIntegerValueSchema).default([]),
  });

export const metabaseMappingsSchema = z
  .object({
    databaseMappings: z
      .record(z.string(), stringTargetSchema)
      .default({})
      .describe('Map of Metabase database ID (positive integer string) to KTX connection ID. Use null to explicitly unmap.'),
    syncEnabled: z
      .record(z.string(), z.boolean())
      .default({})
      .describe('Per-Metabase-database sync toggle, keyed by Metabase database ID string.'),
    syncMode: metabaseSyncModeSchema
      .default('ALL')
      .describe('Sync scope: ALL ingests every mapped DB; ONLY restricts to syncEnabled=true; EXCEPT excludes syncEnabled=true.'),
    selections: metabaseSelectionsSchema
      .default({ collections: [], items: [] })
      .describe('Optional Metabase collection and item IDs to scope ingest.'),
    defaultTagNames: z
      .array(z.string().min(1))
      .default([])
      .describe('Default tag names applied to ingested Metabase artifacts.'),
  })
  .describe('Metabase database-to-warehouse mapping and sync configuration.');

export const lookerMappingsSchema = z
  .object({
    connectionMappings: z
      .record(z.string().min(1), stringTargetSchema)
      .default({})
      .describe('Map of Looker connection name to KTX connection ID. Use null to explicitly unmap.'),
  })
  .describe('Looker connection-to-warehouse mapping configuration.');

export const lookmlMappingsSchema = z
  .object({
    expectedLookerConnectionName: z
      .string()
      .min(1)
      .nullable()
      .default(null)
      .describe('Looker connection name that LookML models must declare; mismatches block sl_write_source at ingest time.'),
  })
  .describe('LookML connection-name expectation for ingest gating.');

export type MetabaseMappingBootstrap = {
  adapter: 'metabase';
  connectionId: string;
  databaseMappings: Record<string, string | null>;
  syncEnabled: Record<string, boolean>;
  syncMode: z.infer<typeof metabaseSyncModeSchema>;
  selections: { collections: number[]; items: number[] };
  defaultTagNames: string[];
};

export type LookerMappingBootstrap = {
  adapter: 'looker';
  connectionId: string;
  connectionMappings: Record<string, string | null>;
};

export type LookmlMappingBootstrap = {
  adapter: 'lookml';
  connectionId: string;
  expectedLookerConnectionName: string | null;
};

export type ConnectionMappingBootstrap = MetabaseMappingBootstrap | LookerMappingBootstrap | LookmlMappingBootstrap;

type MappingConnectionInput = Record<string, unknown> & {
  driver?: unknown;
  mappings?: unknown;
};

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function assertPositiveIntegerKeys(field: string, record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (!/^[1-9]\d*$/.test(key)) {
      throw new Error(`${field} key "${key}" must be a positive integer string`);
    }
  }
}

function driverOf(connection: MappingConnectionInput): string {
  return String(connection.driver ?? '').toLowerCase();
}

export function parseMetabaseMappingBootstrap(
  connectionId: string,
  connection: MappingConnectionInput,
): MetabaseMappingBootstrap {
  const rawMappings = recordValue(connection.mappings);
  assertPositiveIntegerKeys('databaseMappings', recordValue(rawMappings.databaseMappings));
  assertPositiveIntegerKeys('syncEnabled', recordValue(rawMappings.syncEnabled));
  const parsed = metabaseMappingsSchema.parse(rawMappings);
  return {
    adapter: 'metabase',
    connectionId,
    databaseMappings: parsed.databaseMappings,
    syncEnabled: parsed.syncEnabled,
    syncMode: parsed.syncMode,
    selections: parsed.selections,
    defaultTagNames: parsed.defaultTagNames,
  };
}

export function parseLookerMappingBootstrap(
  connectionId: string,
  connection: MappingConnectionInput,
): LookerMappingBootstrap {
  const parsed = lookerMappingsSchema.parse(recordValue(connection.mappings));
  return {
    adapter: 'looker',
    connectionId,
    connectionMappings: parsed.connectionMappings,
  };
}

export function parseLookmlMappingBootstrap(
  connectionId: string,
  connection: MappingConnectionInput,
): LookmlMappingBootstrap {
  const parsed = lookmlMappingsSchema.parse(recordValue(connection.mappings));
  return {
    adapter: 'lookml',
    connectionId,
    expectedLookerConnectionName: parsed.expectedLookerConnectionName,
  };
}

export function parseConnectionMappingBootstrap(
  connectionId: string,
  connection: MappingConnectionInput,
): ConnectionMappingBootstrap | null {
  if (!connection.mappings || typeof connection.mappings !== 'object' || Array.isArray(connection.mappings)) {
    return null;
  }

  const driver = driverOf(connection);
  if (driver === 'metabase') {
    return parseMetabaseMappingBootstrap(connectionId, connection);
  }
  if (driver === 'looker') {
    return parseLookerMappingBootstrap(connectionId, connection);
  }
  if (driver === 'lookml') {
    return parseLookmlMappingBootstrap(connectionId, connection);
  }
  return null;
}
