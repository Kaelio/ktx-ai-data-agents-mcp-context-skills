import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

/** @internal */
export const TELEMETRY_NOTICE =
  'ktx collects usage data to improve the product. Opt out: set KTX_TELEMETRY_DISABLED=1.';

const NOTICE_VERSION = 1;

const telemetryFileSchema = z
  .object({
    installId: z.uuid(),
    enabled: z.boolean(),
    noticeShownAt: z.string().optional(),
    noticeShownVersion: z.number().int().optional(),
    createdAt: z.string(),
  })
  .strict();

/** @internal */
export interface TelemetryIdentityEnv {
  KTX_TELEMETRY_DISABLED?: string;
  DO_NOT_TRACK?: string;
  CI?: string;
  NO_COLOR?: string;
  TERM?: string;
}

function styleNotice(notice: string, env: TelemetryIdentityEnv): string {
  if (env.NO_COLOR || env.TERM === 'dumb') return notice;
  return `[2m${notice}[22m`;
}

export interface LoadTelemetryIdentityOptions {
  homeDir?: string;
  env?: TelemetryIdentityEnv;
  stderr: { write(chunk: string): void };
  now?: () => Date;
}

export interface TelemetryIdentityState {
  installId?: string;
  enabled: boolean;
  createdFile: boolean;
  noticeShown: boolean;
  path: string;
}

function telemetryPath(homeDir: string): string {
  return join(homeDir, '.ktx', 'telemetry.json');
}

function envDisablesTelemetry(env: TelemetryIdentityEnv): boolean {
  return Boolean(env.KTX_TELEMETRY_DISABLED || env.DO_NOT_TRACK || env.CI);
}

async function readTelemetryFile(path: string): Promise<z.infer<typeof telemetryFileSchema> | null> {
  try {
    return telemetryFileSchema.parse(JSON.parse(await readFile(path, 'utf-8')));
  } catch {
    return null;
  }
}

async function writeTelemetryFile(path: string, value: z.infer<typeof telemetryFileSchema>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

export async function loadTelemetryIdentity(options: LoadTelemetryIdentityOptions): Promise<TelemetryIdentityState> {
  const env = options.env ?? process.env;
  const path = telemetryPath(options.homeDir ?? homedir());

  if (envDisablesTelemetry(env)) {
    return { enabled: false, createdFile: false, noticeShown: false, path };
  }

  // Honor an already-consented identity regardless of the current surface.
  // Telemetry enablement follows the persisted decision and opt-out env vars,
  // not whether this invocation happens to own a TTY — MCP servers always run
  // headless (stdio stubs stdout; the HTTP server runs detached).
  const existing = await readTelemetryFile(path);
  if (existing) {
    return {
      installId: existing.installId,
      enabled: existing.enabled,
      createdFile: false,
      noticeShown: false,
      path,
    };
  }

  // No identity yet → mint one regardless of surface. Telemetry is opt-out, so
  // a fresh install is counted even when its first run is headless (an
  // IDE-launched `ktx mcp stdio`, a scripted invocation); otherwise those
  // installs would be permanently invisible. Opt-out env vars are honored
  // above. The one-time notice is written to stderr — safe even under MCP
  // stdio, which reserves stdout for its JSON-RPC protocol.
  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  const next = {
    installId: randomUUID(),
    enabled: true,
    noticeShownAt: timestamp,
    noticeShownVersion: NOTICE_VERSION,
    createdAt: timestamp,
  };

  try {
    await writeTelemetryFile(path, next);
  } catch {
    return {
      enabled: false,
      createdFile: false,
      noticeShown: false,
      path,
    };
  }

  options.stderr.write(`${styleNotice(TELEMETRY_NOTICE, env)}\n`);

  return {
    installId: next.installId,
    enabled: true,
    createdFile: true,
    noticeShown: true,
    path,
  };
}

export function computeTelemetryProjectId(installId: string, projectDir: string): string {
  return createHash('sha256').update(`${installId}:${resolve(projectDir)}`).digest('hex');
}

export async function readExistingTelemetryProjectId(options: {
  projectDir: string;
  homeDir?: string;
  env?: Pick<TelemetryIdentityEnv, 'KTX_TELEMETRY_DISABLED' | 'DO_NOT_TRACK'>;
}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  if (env.KTX_TELEMETRY_DISABLED || env.DO_NOT_TRACK) {
    return undefined;
  }

  const existing = await readTelemetryFile(telemetryPath(options.homeDir ?? homedir()));
  if (!existing?.enabled) {
    return undefined;
  }

  return computeTelemetryProjectId(existing.installId, options.projectDir);
}
