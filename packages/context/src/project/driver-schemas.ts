import * as z from 'zod';
import {
  lookerMappingsSchema,
  lookmlMappingsSchema,
  metabaseMappingsSchema,
} from './mappings-yaml-schema.js';

const warehouseDrivers = [
  'postgres',
  'postgresql',
  'mysql',
  'snowflake',
  'bigquery',
  'sqlite',
  'clickhouse',
  'sqlserver',
] as const;

type WarehouseDriver = (typeof warehouseDrivers)[number];

function warehouseConnectionSchema<const Driver extends WarehouseDriver>(driver: Driver) {
  return z
    .looseObject({
      driver: z.literal(driver),
      url: z
        .string()
        .min(1)
        .optional()
        .describe('Warehouse connection URL or DSN; may contain environment-variable references like env:DATABASE_URL.'),
    })
    .describe(
      `${driver} warehouse connection. Additional driver-tunable fields (e.g. historicSql, context.queryHistory) are accepted and passed through.`,
    );
}

const warehouseConnectionSchemas = [
  warehouseConnectionSchema('postgres'),
  warehouseConnectionSchema('postgresql'),
  warehouseConnectionSchema('mysql'),
  warehouseConnectionSchema('snowflake'),
  warehouseConnectionSchema('bigquery'),
  warehouseConnectionSchema('sqlite'),
  warehouseConnectionSchema('clickhouse'),
  warehouseConnectionSchema('sqlserver'),
] as const;

const positiveIntKeyMessage = (field: string) => `${field} keys must be positive-integer strings (e.g. "1", "42")`;

const positiveIntKeyRegex = /^[1-9]\d*$/;

const metabaseMappingsStrictSchema = metabaseMappingsSchema.superRefine((value, ctx) => {
  for (const key of Object.keys(value.databaseMappings ?? {})) {
    if (!positiveIntKeyRegex.test(key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['databaseMappings', key],
        message: positiveIntKeyMessage('databaseMappings'),
      });
    }
  }
  for (const key of Object.keys(value.syncEnabled ?? {})) {
    if (!positiveIntKeyRegex.test(key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['syncEnabled', key],
        message: positiveIntKeyMessage('syncEnabled'),
      });
    }
  }
});

const metabaseConnectionSchema = z
  .looseObject({
    driver: z.literal('metabase'),
    api_url: z.string().url().describe('Metabase instance API URL (e.g. https://metabase.example.com).'),
    api_key: z.string().min(1).optional().describe('Literal Metabase API key. Prefer api_key_ref for safety.'),
    api_key_ref: z
      .string()
      .min(1)
      .optional()
      .describe('Reference to Metabase API key (e.g. env:METABASE_API_KEY or file:/path).'),
    network_proxy: z.looseObject({}).optional().describe('Optional network proxy configuration (snake_case form).'),
    networkProxy: z.looseObject({}).optional().describe('Optional network proxy configuration (camelCase form).'),
    mappings: metabaseMappingsStrictSchema
      .optional()
      .describe('Metabase database-to-warehouse mappings and sync configuration.'),
  })
  .describe('Metabase context-source connection.');

const lookerConnectionSchema = z
  .looseObject({
    driver: z.literal('looker'),
    base_url: z.string().url().describe('Looker instance base URL (e.g. https://looker.example.com).'),
    client_id: z.string().min(1).describe('Looker OAuth client ID.'),
    client_secret: z.string().min(1).optional().describe('Literal Looker OAuth client secret. Prefer client_secret_ref.'),
    client_secret_ref: z
      .string()
      .min(1)
      .optional()
      .describe('Reference to Looker OAuth client secret (e.g. env:LOOKER_CLIENT_SECRET).'),
    mappings: lookerMappingsSchema.optional().describe('Looker connection-name to KTX warehouse mappings.'),
  })
  .describe('Looker context-source connection.');

const lookmlConnectionSchema = z
  .looseObject({
    driver: z.literal('lookml'),
    repoUrl: z
      .string()
      .min(1)
      .describe('Git URL of the LookML project (https, ssh, or file:). Field is camelCase by convention.'),
    branch: z.string().min(1).optional().describe('Git branch (default "main" downstream).'),
    path: z.string().optional().describe('Subdirectory within the repo when the LookML project lives in a monorepo.'),
    auth_token_ref: z.string().min(1).optional().describe('Reference to Git auth token for private repos (e.g. env:GITHUB_TOKEN).'),
    mappings: lookmlMappingsSchema.optional().describe('LookML expected-connection mapping for ingest gating.'),
  })
  .describe('LookML context-source connection.');

export const connectionConfigSchema = z.discriminatedUnion('driver', [
  ...warehouseConnectionSchemas,
  metabaseConnectionSchema,
  lookerConnectionSchema,
  lookmlConnectionSchema,
]);

export type KtxConnectionConfig = z.infer<typeof connectionConfigSchema>;
