import * as z from 'zod';

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

export const connectionConfigSchema = z.discriminatedUnion('driver', warehouseConnectionSchemas);

export type KtxConnectionConfig = z.infer<typeof connectionConfigSchema>;
