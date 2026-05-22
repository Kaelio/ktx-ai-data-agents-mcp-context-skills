import type { BuiltTelemetryEvent } from './events.js';

export interface TelemetryEmitterEnv {
  KTX_TELEMETRY_DEBUG?: string;
  KTX_TELEMETRY_ENDPOINT?: string;
}

export interface TelemetrySink {
  write(chunk: string): void;
}

type PostHogClient = {
  capture(event: {
    distinctId: string;
    event: string;
    properties: Record<string, unknown>;
    groups?: Record<string, string>;
    disableGeoip?: boolean;
  }): void;
  groupIdentify(event: { groupType: string; groupKey: string; distinctId?: string }): void;
  shutdown(): Promise<void> | void;
};

// PostHog public project ingestion key — safe to embed; capture-only, no read access.
const POSTHOG_PROJECT_API_KEY = 'phc_xbvZpbu8ZNLnogTbY7MEMWhCF2rzzApYsDndjKaRBXXx'; // pragma: allowlist secret
const POSTHOG_HOST = 'https://us.i.posthog.com';
const SHUTDOWN_TIMEOUT_MS = 1500;

let clientPromise: Promise<PostHogClient | null> | undefined;
const identifiedProjects = new Set<string>();

function telemetryHost(env: TelemetryEmitterEnv, explicitHost?: string): string {
  return explicitHost ?? env.KTX_TELEMETRY_ENDPOINT ?? POSTHOG_HOST;
}

function telemetryProjectApiKey(explicitProjectApiKey?: string): string {
  return explicitProjectApiKey ?? POSTHOG_PROJECT_API_KEY;
}

function liveTelemetryConfigured(projectApiKey: string, host: string): boolean {
  return projectApiKey.trim() !== '' && host.trim() !== '';
}

async function getPostHogClient(projectApiKey: string, host: string): Promise<PostHogClient | null> {
  if (!liveTelemetryConfigured(projectApiKey, host)) {
    return null;
  }

  clientPromise ??= import('posthog-node')
    .then(({ PostHog }) => new PostHog(projectApiKey, { host, flushAt: 1, flushInterval: 0, disableGeoip: true }))
    .catch(() => null);

  return await clientPromise;
}

function debugEnabled(env: TelemetryEmitterEnv): boolean {
  return env.KTX_TELEMETRY_DEBUG === '1';
}

function writeDebugPayload(input: {
  event: BuiltTelemetryEvent;
  distinctId: string;
  projectId?: string;
  stderr: TelemetrySink;
}): void {
  input.stderr.write(
    `[telemetry] ${JSON.stringify({
      distinctId: input.distinctId,
      event: input.event.name,
      properties: input.event.properties,
      groups: input.projectId ? { project: input.projectId } : undefined,
    })}\n`,
  );
}

/** @internal */
export async function groupIdentifyProject(input: {
  distinctId: string;
  projectId: string;
  env?: TelemetryEmitterEnv;
  projectApiKey?: string;
  host?: string;
}): Promise<void> {
  const env = input.env ?? process.env;
  const projectApiKey = telemetryProjectApiKey(input.projectApiKey);
  const host = telemetryHost(env, input.host);
  const projectKey = `${host}:${input.projectId}`;

  if (identifiedProjects.has(projectKey)) {
    return;
  }
  identifiedProjects.add(projectKey);

  const client = await getPostHogClient(projectApiKey, host);
  if (!client) {
    return;
  }

  try {
    client.groupIdentify({
      groupType: 'project',
      groupKey: input.projectId,
      distinctId: input.distinctId,
    });
  } catch {
    return;
  }
}

export async function trackTelemetryEvent(input: {
  event: BuiltTelemetryEvent;
  distinctId: string;
  projectId?: string;
  env?: TelemetryEmitterEnv;
  stderr: TelemetrySink;
  projectApiKey?: string;
  host?: string;
}): Promise<void> {
  const env = input.env ?? process.env;

  if (debugEnabled(env)) {
    writeDebugPayload(input);
    return;
  }

  const projectApiKey = telemetryProjectApiKey(input.projectApiKey);
  const host = telemetryHost(env, input.host);
  const client = await getPostHogClient(projectApiKey, host);
  if (!client) {
    return;
  }

  try {
    if (input.projectId) {
      await groupIdentifyProject({
        distinctId: input.distinctId,
        projectId: input.projectId,
        env,
        projectApiKey,
        host,
      });
    }

    client.capture({
      distinctId: input.distinctId,
      event: input.event.name,
      properties: input.event.properties,
      groups: input.projectId ? { project: input.projectId } : undefined,
      disableGeoip: true,
    });
  } catch {
    return;
  }
}

export async function shutdownTelemetryEmitter(): Promise<void> {
  const client = await clientPromise;
  if (!client) {
    return;
  }

  await Promise.race([
    Promise.resolve(client.shutdown()).catch(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
    }),
  ]);
}

/** @internal */
export function __resetTelemetryEmitterForTests(): void {
  clientPromise = undefined;
  identifiedProjects.clear();
}
