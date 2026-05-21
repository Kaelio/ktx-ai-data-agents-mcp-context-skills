import * as z from 'zod';
import { parsedTargetTableSchema } from '../../parsed-target-table.js';

const lookmlPullConfigSchema = z.object({
  repoUrl: z.string().url(),
  branch: z.string().default('main'),
  path: z.string().nullable().default(null),
  authToken: z.string().nullable().default(null),
  expectedLookerConnectionName: z.string().min(1).nullable().default(null),
  parsedTargetTables: z.record(z.string(), parsedTargetTableSchema).default({}),
});

export type LookmlPullConfig = z.infer<typeof lookmlPullConfigSchema>;

export interface LookmlIntegrationLike {
  repoUrl: string | null;
  branch?: string | null;
  path?: string | null;
  authToken?: string | null;
  expectedLookerConnectionName?: string | null;
}

export function parseLookmlPullConfig(raw: unknown): LookmlPullConfig {
  return lookmlPullConfigSchema.parse(raw);
}

export function pullConfigFromIntegrationConfig(integration: LookmlIntegrationLike): LookmlPullConfig {
  if (!integration.repoUrl) {
    throw new Error('lookml integration config missing repoUrl');
  }
  return parseLookmlPullConfig({
    repoUrl: integration.repoUrl,
    branch: integration.branch ?? 'main',
    path: integration.path ?? null,
    authToken: integration.authToken ?? null,
    expectedLookerConnectionName: integration.expectedLookerConnectionName ?? null,
    parsedTargetTables: {},
  });
}
