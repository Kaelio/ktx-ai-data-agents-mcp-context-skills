import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

import { telemetryEventCatalog, telemetryEventSchemas } from './events.js';

const commonFields = ['cliVersion', 'nodeVersion', 'osPlatform', 'osRelease', 'arch', 'runtime', 'isCi'] as const;

export interface TelemetrySchemaArtifact {
  $schema: 'https://json-schema.org/draft/2020-12/schema';
  title: 'ktx telemetry events';
  type: 'object';
  additionalProperties: false;
  'x-ktx-common-fields': string[];
  'x-ktx-catalog': Array<{ name: string; description: string; fields: readonly string[] }>;
  $defs: Record<string, unknown>;
}

/** @internal */
export function buildTelemetrySchemaArtifact(): TelemetrySchemaArtifact {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'ktx telemetry events',
    type: 'object',
    additionalProperties: false,
    'x-ktx-common-fields': [...commonFields],
    'x-ktx-catalog': telemetryEventCatalog.map((event) => ({
      name: event.name,
      description: event.description,
      fields: event.fields,
    })),
    $defs: Object.fromEntries(
      Object.entries(telemetryEventSchemas).map(([name, schema]) => [
        name,
        z.toJSONSchema(schema, { target: 'draft-2020-12' }),
      ]),
    ),
  };
}

async function writeTelemetrySchemaArtifact(path: string): Promise<void> {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(buildTelemetrySchemaArtifact(), null, 2)}\n`, 'utf-8');
}

async function main(argv: string[]): Promise<void> {
  const targets = argv.slice(2);
  if (targets.length === 0) {
    throw new Error('Usage: node dist/telemetry/schema-writer.js <target> [target...]');
  }
  for (const target of targets) {
    await writeTelemetrySchemaArtifact(target);
  }
}

if (import.meta.url === pathToFileURL(fileURLToPath(import.meta.url)).href && process.argv[1]) {
  const invoked = pathToFileURL(resolve(process.argv[1])).href;
  if (import.meta.url === invoked) {
    await main(process.argv);
  }
}
