import type { KtxCliIo, KtxCliPackageInfo } from '../cli-runtime.js';
import {
  beginCommandSpan,
  completeCommandSpan,
  type CommandOutcome,
  type CompletedCommandSpan,
} from './command-hook.js';
import { shutdownTelemetryEmitter, trackTelemetryEvent } from './emitter.js';
import { buildCommonEnvelope, buildTelemetryEvent } from './events.js';
import { computeTelemetryProjectId, loadTelemetryIdentity } from './identity.js';

export { beginCommandSpan, completeCommandSpan, shutdownTelemetryEmitter };
export type { CommandOutcome, CompletedCommandSpan };

async function emitInstallFirstRunIfNeeded(input: {
  identity: Awaited<ReturnType<typeof loadTelemetryIdentity>>;
  packageInfo: KtxCliPackageInfo;
  io: KtxCliIo;
}): Promise<void> {
  if (!input.identity.enabled || !input.identity.createdFile || !input.identity.installId) {
    return;
  }

  await trackTelemetryEvent({
    event: buildTelemetryEvent(
      'install_first_run',
      buildCommonEnvelope({
        cliVersion: input.packageInfo.version,
        isCi: Boolean(process.env.CI),
      }),
      {},
    ),
    distinctId: input.identity.installId,
    env: process.env,
    stderr: input.io.stderr,
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

  const identity = await loadTelemetryIdentity({
    stdoutIsTTY: input.io.stdout.isTTY === true,
    stderr: input.io.stderr,
    env: process.env,
  });

  if (!identity.enabled || !identity.installId) {
    return;
  }

  await emitInstallFirstRunIfNeeded({ identity, packageInfo: input.packageInfo, io: input.io });

  const projectId =
    input.completed.projectGroupAttached && input.completed.projectDir
      ? computeTelemetryProjectId(identity.installId, input.completed.projectDir)
      : undefined;

  const { projectDir: _projectDir, ...eventFields } = input.completed;
  await trackTelemetryEvent({
    event: buildTelemetryEvent(
      'command',
      buildCommonEnvelope({
        cliVersion: input.packageInfo.version,
        isCi: Boolean(process.env.CI),
      }),
      eventFields,
    ),
    distinctId: identity.installId,
    projectId,
    env: process.env,
    stderr: input.io.stderr,
  });
}
