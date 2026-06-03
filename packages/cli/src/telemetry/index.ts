import { getKtxCliPackageInfo, type KtxCliIo, type KtxCliPackageInfo } from '../cli-runtime.js';
import { loadKtxProject } from '../context/project/project.js';
import {
  beginCommandSpan,
  completeCommandSpan,
  type CommandOutcome,
  type CompletedCommandSpan,
} from './command-hook.js';
import { shutdownTelemetryEmitter, trackTelemetryEvent } from './emitter.js';
import {
  buildCommonEnvelope,
  buildTelemetryEvent,
  type TelemetryCommonEnvelope,
  type TelemetryEventName,
  type TelemetryEventProperties,
} from './events.js';
import { computeTelemetryProjectId, loadTelemetryIdentity } from './identity.js';
import { buildProjectStackSnapshotFields } from './project-snapshot.js';

export { beginCommandSpan, completeCommandSpan, shutdownTelemetryEmitter };
export type { CommandOutcome, CompletedCommandSpan };

export async function showTelemetryNoticeIfNeeded(io: KtxCliIo, packageInfo: KtxCliPackageInfo): Promise<void> {
  const identity = await loadTelemetryIdentity({
    stderr: io.stderr,
    env: process.env,
  });

  if (!identity.enabled || !identity.createdFile || !identity.installId) {
    return;
  }

  await trackTelemetryEvent({
    event: buildTelemetryEvent(
      'install_first_run',
      buildCommonEnvelope({
        cliVersion: packageInfo.version,
        isCi: Boolean(process.env.CI),
      }),
      {},
    ),
    distinctId: identity.installId,
    env: process.env,
    stderr: io.stderr,
  });
}

type TelemetryEventFields<Name extends TelemetryEventName> = Omit<
  TelemetryEventProperties<Name>,
  keyof TelemetryCommonEnvelope
>;

const emittedProjectSnapshots = new Set<string>();
// MCP tool calls are captured at full rate while ktx is early-stage: at current
// install counts any sampling below 1.0 yields too few events to be useful, and
// the recorded sampleRate lets us dial this down (and reweight history) once
// per-session call volume justifies it.
const MCP_SAMPLE_RATE = 1 as const;
let mcpSampled: boolean | undefined;

function telemetryDebugEnabled(): boolean {
  return process.env.KTX_TELEMETRY_DEBUG === '1';
}

export function shouldEmitMcpTelemetry(): boolean {
  mcpSampled ??= Math.random() < MCP_SAMPLE_RATE;
  return mcpSampled;
}

export function mcpTelemetrySampleRate(): 1 {
  return MCP_SAMPLE_RATE;
}

export async function emitTelemetryEvent<Name extends TelemetryEventName>(input: {
  name: Name;
  fields: TelemetryEventFields<Name>;
  io: KtxCliIo;
  packageInfo?: KtxCliPackageInfo;
  projectDir?: string;
}): Promise<void> {
  const debug = telemetryDebugEnabled();
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
  await trackTelemetryEvent({
    event: buildTelemetryEvent(
      input.name,
      buildCommonEnvelope({
        cliVersion: packageInfo.version,
        isCi: Boolean(process.env.CI),
      }),
      input.fields,
    ),
    distinctId: installId,
    projectId,
    env: process.env,
    stderr: input.io.stderr,
  });
}

export async function emitProjectStackSnapshot(input: {
  projectDir: string;
  io: KtxCliIo;
  packageInfo?: KtxCliPackageInfo;
}): Promise<void> {
  if (emittedProjectSnapshots.has(input.projectDir)) {
    return;
  }
  emittedProjectSnapshots.add(input.projectDir);

  let project: Awaited<ReturnType<typeof loadKtxProject>>;
  try {
    project = await loadKtxProject({ projectDir: input.projectDir });
  } catch {
    return;
  }
  await emitTelemetryEvent({
    name: 'project_stack_snapshot',
    fields: await buildProjectStackSnapshotFields(project),
    projectDir: input.projectDir,
    io: input.io,
    packageInfo: input.packageInfo,
  });
}

export async function emitCompletedCommand(input: {
  completed: CompletedCommandSpan | undefined;
  packageInfo: KtxCliPackageInfo;
  io: KtxCliIo;
}): Promise<void> {
  if (!input.completed) {
    return;
  }

  const projectDir = input.completed.projectGroupAttached ? input.completed.projectDir : undefined;
  const { projectDir: _projectDir, ...eventFields } = input.completed;
  await emitTelemetryEvent({
    name: 'command',
    fields: eventFields,
    projectDir,
    io: input.io,
    packageInfo: input.packageInfo,
  });
}

/**
 * Flush telemetry when the process is interrupted (Ctrl-C / kill). The normal
 * `command` emit + flush lives in a `finally` that a signal skips, so without
 * this an interrupted long-running command (ingest, `mcp stdio`) loses its
 * `command` event and any queued events. Marks the active command span as
 * `aborted`, emits it, and drains the emitter. Best-effort and idempotent: if
 * the span was already completed (normal exit racing a signal) the emit no-ops.
 */
export async function emitAbortedCommandAndShutdown(input: {
  packageInfo: KtxCliPackageInfo;
  io: KtxCliIo;
}): Promise<void> {
  const completed = completeCommandSpan({ completedAt: performance.now(), outcome: 'aborted' });
  await emitCompletedCommand({ completed, packageInfo: input.packageInfo, io: input.io });
  await shutdownTelemetryEmitter();
}
