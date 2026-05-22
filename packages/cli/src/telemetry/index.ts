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
    stdoutIsTTY: io.stdout.isTTY === true,
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
const MCP_SAMPLE_RATE = 0.1 as const;
let mcpSampled: boolean | undefined;

export function shouldEmitMcpTelemetry(): boolean {
  mcpSampled ??= Math.random() < MCP_SAMPLE_RATE;
  return mcpSampled;
}

export function mcpTelemetrySampleRate(): 0.1 {
  return MCP_SAMPLE_RATE;
}

export async function emitTelemetryEvent<Name extends TelemetryEventName>(input: {
  name: Name;
  fields: TelemetryEventFields<Name>;
  io: KtxCliIo;
  packageInfo?: KtxCliPackageInfo;
  projectDir?: string;
}): Promise<void> {
  const identity = await loadTelemetryIdentity({
    stdoutIsTTY: input.io.stdout.isTTY === true,
    stderr: input.io.stderr,
    env: process.env,
  });

  if (!identity.enabled || !identity.installId) {
    return;
  }

  const packageInfo = input.packageInfo ?? getKtxCliPackageInfo();

  const projectId = input.projectDir ? computeTelemetryProjectId(identity.installId, input.projectDir) : undefined;
  await trackTelemetryEvent({
    event: buildTelemetryEvent(
      input.name,
      buildCommonEnvelope({
        cliVersion: packageInfo.version,
        isCi: Boolean(process.env.CI),
      }),
      input.fields,
    ),
    distinctId: identity.installId,
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
