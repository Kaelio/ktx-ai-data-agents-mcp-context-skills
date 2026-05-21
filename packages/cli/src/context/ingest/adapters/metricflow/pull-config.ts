import { z } from 'zod';
import { parsedTargetTableSchema } from '../../parsed-target-table.js';

const metricflowPullConfigSchema = z.object({
  repoUrl: z.string().url(),
  branch: z.string().default('main'),
  path: z.string().nullable().default(null),
  authToken: z.string().nullable().default(null),
  parsedTargetTables: z.record(z.string(), parsedTargetTableSchema).default({}),
});

export type MetricflowPullConfig = z.infer<typeof metricflowPullConfigSchema>;

export interface MetricflowIntegrationLike {
  repoUrl: string | null;
  branch?: string | null;
  path?: string | null;
  authToken?: string | null;
  parsedTargetTables?: Record<string, z.infer<typeof parsedTargetTableSchema>>;
}

export function parseMetricflowPullConfig(raw: unknown): MetricflowPullConfig {
  return metricflowPullConfigSchema.parse(raw);
}

export function pullConfigFromMetricflowIntegration(integration: MetricflowIntegrationLike): MetricflowPullConfig {
  if (!integration.repoUrl) {
    throw new Error('metricflow integration config missing repoUrl');
  }
  return parseMetricflowPullConfig({
    repoUrl: integration.repoUrl,
    branch: integration.branch ?? 'main',
    path: integration.path ?? null,
    authToken: integration.authToken ?? null,
    parsedTargetTables: integration.parsedTargetTables ?? {},
  });
}
