import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { parsedTargetTableSchema, type ParsedTargetTable } from '../../parsed-target-table.js';
import type { MetricflowHostTable } from './semantic-models.js';

const METRICFLOW_PROJECTION_CONFIG_FILE = 'sync-config.json';

const metricflowProjectionConfigSchema = z.object({
  parsedTargetTables: z.record(z.string(), parsedTargetTableSchema).default({}),
});

export type MetricflowProjectionConfig = z.infer<typeof metricflowProjectionConfigSchema>;

export async function writeMetricflowProjectionConfig(
  stagedDir: string,
  config: MetricflowProjectionConfig,
): Promise<void> {
  const parsed = metricflowProjectionConfigSchema.parse(config);
  await mkdir(stagedDir, { recursive: true });
  await writeFile(join(stagedDir, METRICFLOW_PROJECTION_CONFIG_FILE), `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
}

export async function readMetricflowProjectionConfig(stagedDir: string): Promise<MetricflowProjectionConfig> {
  const path = join(stagedDir, METRICFLOW_PROJECTION_CONFIG_FILE);
  try {
    return metricflowProjectionConfigSchema.parse(JSON.parse(await readFile(path, 'utf-8')));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { parsedTargetTables: {} };
    }
    throw error;
  }
}

export function metricflowHostTablesFromParsedTargets(
  parsedTargetTables: Record<string, ParsedTargetTable>,
): MetricflowHostTable[] {
  return Object.entries(parsedTargetTables)
    .flatMap(([id, table]) =>
      table.ok
        ? [
            {
              id,
              name: table.name,
              catalog: table.catalog,
              db: table.schema,
              columns: [],
            },
          ]
        : [],
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}
