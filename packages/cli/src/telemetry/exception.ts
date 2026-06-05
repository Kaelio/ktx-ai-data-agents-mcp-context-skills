import { inspect } from 'node:util';

import { getKtxCliPackageInfo, type KtxCliIo, type KtxCliPackageInfo } from '../cli-runtime.js';
import { buildCommonEnvelope } from './events.js';
import { trackTelemetryException } from './emitter.js';
import { computeTelemetryProjectId, loadTelemetryIdentity } from './identity.js';

export interface ExceptionContext {
  source: string;
  handled: boolean;
  fatal: boolean;
  extra?: Record<string, string | number | boolean>;
}

type AnyObject = object;

const reportedObjects = new WeakSet<AnyObject>();
const recentHandledPrimitives: string[] = [];
const RECENT_PRIMITIVE_LIMIT = 128;

function primitiveKey(value: unknown): string {
  return `${typeof value}:${String(value)}`;
}

function rememberHandledPrimitive(value: unknown): void {
  recentHandledPrimitives.push(primitiveKey(value));
  if (recentHandledPrimitives.length > RECENT_PRIMITIVE_LIMIT) {
    recentHandledPrimitives.splice(0, recentHandledPrimitives.length - RECENT_PRIMITIVE_LIMIT);
  }
}

function consumeHandledPrimitive(value: unknown): boolean {
  const key = primitiveKey(value);
  const index = recentHandledPrimitives.indexOf(key);
  if (index < 0) {
    return false;
  }
  recentHandledPrimitives.splice(index, 1);
  return true;
}

function shouldSkipAsAlreadyReported(error: unknown, handled: boolean): boolean {
  if ((typeof error === 'object' || typeof error === 'function') && error !== null) {
    if (reportedObjects.has(error)) {
      return true;
    }
    reportedObjects.add(error);
    return false;
  }

  if (handled) {
    rememberHandledPrimitive(error);
    return false;
  }

  return consumeHandledPrimitive(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactStaticPatterns(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi, '$1[redacted]$3')
    .replace(/\b(password|pwd)=([^;&\s]+)/gi, '$1=[redacted]')
    .replace(/\bAuthorization\s*:\s*[^\r\n,;]+/gi, 'Authorization: [redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key)\s*[:=]\s*([^\s,;]+)/gi, '$1=[redacted]')
    .replace(/\b(KTX_[A-Z0-9_]*|[A-Z0-9_]*(?:TOKEN|SECRET))\s*[:=]\s*([^\s,;]+)/g, '$1=[redacted]')
    .replace(/([?&](?:X-Amz-Signature|X-Goog-Signature|sig)=)[^&\s]+/gi, '$1[redacted]');
}

function redactText(value: string, secrets: ReadonlyArray<string>): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) {
      redacted = redacted.replace(new RegExp(escapeRegExp(secret), 'g'), '[redacted]');
    }
  }
  return redactStaticPatterns(redacted);
}

const FORBIDDEN_EXTRA_PROPERTY_KEYS = new Set([
  'argv',
  'args',
  'env',
  'environment',
  'sql',
  'query',
  'prompt',
  'mcparguments',
  'mcpargs',
  'tablename',
  'schemaname',
  'columnname',
  'databaseurl',
  'connectionstring',
  'url',
  'password',
  'token',
  'apikey',
  'api_key',
  'authorization',
]);

function safeExtraProperties(
  extra: Record<string, string | number | boolean> | undefined,
): Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (!FORBIDDEN_EXTRA_PROPERTY_KEYS.has(key.replace(/[^a-z0-9_]/gi, '').toLowerCase())) {
      safe[key] = value;
    }
  }
  return safe;
}

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return inspect(error, { depth: 4, breakLength: 120 });
}

function sanitizedError(error: unknown, secrets: ReadonlyArray<string>): Error {
  if (error instanceof Error) {
    const cause = 'cause' in error ? (error as Error & { cause?: unknown }).cause : undefined;
    const clone = new Error(redactText(error.message, secrets), {
      ...(cause !== undefined ? { cause: sanitizedError(cause, secrets) } : {}),
    });
    clone.name = error.name;
    if (error.stack) {
      clone.stack = redactText(error.stack, secrets);
    }
    return clone;
  }
  return new Error(redactText(toMessage(error), secrets));
}

export async function reportException(input: {
  error: unknown;
  context: ExceptionContext;
  io: KtxCliIo;
  packageInfo?: KtxCliPackageInfo;
  projectDir?: string;
  immediate?: boolean;
  redactionSecrets?: ReadonlyArray<string>;
}): Promise<void> {
  try {
    if (shouldSkipAsAlreadyReported(input.error, input.context.handled)) {
      return;
    }

    const debug = process.env.KTX_TELEMETRY_DEBUG === '1';
    const identity = await loadTelemetryIdentity({
      stderr: input.io.stderr,
      env: process.env,
    });

    if ((!identity.enabled || !identity.installId) && !debug) {
      return;
    }

    const packageInfo = input.packageInfo ?? getKtxCliPackageInfo();
    const installId = identity.installId ?? 'debug';
    const projectId = input.projectDir ? computeTelemetryProjectId(installId, input.projectDir) : undefined;
    const safeError = sanitizedError(input.error, input.redactionSecrets ?? []);
    const properties: Record<string, unknown> = {
      ...buildCommonEnvelope({
        cliVersion: packageInfo.version,
        isCi: Boolean(process.env.CI),
      }),
      source: input.context.source,
      handled: input.context.handled,
      fatal: input.context.fatal,
      ...(projectId ? { projectId } : {}),
      ...safeExtraProperties(input.context.extra),
    };

    delete properties.$groups;
    await trackTelemetryException({
      error: safeError,
      distinctId: installId,
      properties,
      env: process.env,
      stderr: input.io.stderr,
      immediate: input.immediate,
    });
  } catch {
    return;
  }
}

/** @internal */
export function __resetTelemetryExceptionStateForTests(): void {
  recentHandledPrimitives.length = 0;
}
