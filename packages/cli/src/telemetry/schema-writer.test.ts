import { describe, expect, it } from 'vitest';

import { buildTelemetrySchemaArtifact } from './schema-writer.js';

describe('telemetry schema writer', () => {
  it('exports a schema artifact with the full catalog and strict metadata', () => {
    const artifact = buildTelemetrySchemaArtifact();

    expect(artifact.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(artifact['x-ktx-common-fields']).toEqual([
      'cliVersion',
      'nodeVersion',
      'osPlatform',
      'osRelease',
      'arch',
      'runtime',
      'isCi',
    ]);
    expect(artifact['x-ktx-catalog'].map((event) => event.name)).toContain('daemon_started');
    expect(artifact['x-ktx-catalog'].map((event) => event.name)).toContain('sql_gen_completed');
    expect(artifact.$defs.sql_gen_completed).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
  });
});
