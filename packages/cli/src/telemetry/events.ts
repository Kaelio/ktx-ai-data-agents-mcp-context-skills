import { arch, platform, release } from 'node:os';
import { z } from 'zod';

const telemetryCommonEnvelopeSchema = z
  .object({
    cliVersion: z.string(),
    nodeVersion: z.string(),
    osPlatform: z.string(),
    osRelease: z.string(),
    arch: z.string(),
    runtime: z.literal('node'),
    isCi: z.boolean(),
  })
  .strict();

const installFirstRunSchema = telemetryCommonEnvelopeSchema.strict();

const commandSchema = telemetryCommonEnvelopeSchema
  .extend({
    commandPath: z.array(z.string()).min(1),
    durationMs: z.number().nonnegative(),
    outcome: z.enum(['ok', 'error', 'aborted']),
    errorClass: z.string().optional(),
    flagsPresent: z.record(z.string(), z.boolean()),
    hasProject: z.boolean(),
    projectGroupAttached: z.boolean(),
  })
  .strict();

/** @internal */
export const telemetryEventSchemas = {
  install_first_run: installFirstRunSchema,
  command: commandSchema,
} as const;

/** @internal */
export const telemetryEventCatalog = [
  {
    name: 'install_first_run',
    description: 'Emitted once when ~/.ktx/telemetry.json is created.',
    fields: [],
  },
  {
    name: 'command',
    description: 'Emitted once for each Commander action that reaches preAction.',
    fields: [
      'commandPath',
      'durationMs',
      'outcome',
      'errorClass',
      'flagsPresent',
      'hasProject',
      'projectGroupAttached',
    ],
  },
] as const;

export type TelemetryEventName = keyof typeof telemetryEventSchemas;
export type TelemetryCommonEnvelope = z.infer<typeof telemetryCommonEnvelopeSchema>;

export type TelemetryEventProperties<Name extends TelemetryEventName> = z.infer<
  (typeof telemetryEventSchemas)[Name]
>;

export interface BuiltTelemetryEvent<Name extends TelemetryEventName = TelemetryEventName> {
  name: Name;
  properties: TelemetryEventProperties<Name>;
}

export function buildCommonEnvelope(input: { cliVersion: string; isCi: boolean }): TelemetryCommonEnvelope {
  return {
    cliVersion: input.cliVersion,
    nodeVersion: process.version,
    osPlatform: platform(),
    osRelease: release(),
    arch: arch(),
    runtime: 'node',
    isCi: input.isCi,
  };
}

export function buildTelemetryEvent<Name extends TelemetryEventName>(
  name: Name,
  envelope: TelemetryCommonEnvelope,
  fields: Omit<TelemetryEventProperties<Name>, keyof TelemetryCommonEnvelope>,
): BuiltTelemetryEvent<Name> {
  const schema = telemetryEventSchemas[name];
  return {
    name,
    properties: schema.parse({ ...envelope, ...fields }) as TelemetryEventProperties<Name>,
  };
}
