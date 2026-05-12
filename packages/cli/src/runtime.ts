import type { KtxCliIo } from './cli-runtime.js';
import {
  stopAllManagedPythonDaemons,
  startManagedPythonDaemon,
  stopManagedPythonDaemon,
  type ManagedPythonDaemonStopAllResult,
  type ManagedPythonDaemonStartResult,
  type ManagedPythonDaemonStopResult,
} from './managed-python-daemon.js';
import {
  doctorManagedPythonRuntime,
  installManagedPythonRuntime,
  pruneManagedPythonRuntimes,
  readManagedPythonRuntimeStatus,
  type KtxRuntimeFeature,
  type ManagedPythonRuntimeDoctorCheck,
  type ManagedPythonRuntimeInstallOptions,
  type ManagedPythonRuntimeInstallResult,
  type ManagedPythonRuntimeLayoutOptions,
  type ManagedPythonRuntimePruneResult,
  type ManagedPythonRuntimeStatus,
} from './managed-python-runtime.js';

export type KtxRuntimeArgs =
  | { command: 'install'; cliVersion: string; feature: KtxRuntimeFeature; force: boolean }
  | { command: 'start'; cliVersion: string; feature: KtxRuntimeFeature; force: boolean }
  | { command: 'stop'; cliVersion: string; all: boolean }
  | { command: 'status'; cliVersion: string; json: boolean }
  | { command: 'doctor'; cliVersion: string; json: boolean }
  | { command: 'prune'; cliVersion: string; dryRun: boolean; yes: boolean };

export interface KtxRuntimeDeps {
  installRuntime?: (options: ManagedPythonRuntimeInstallOptions) => Promise<ManagedPythonRuntimeInstallResult>;
  startDaemon?: (options: {
    cliVersion: string;
    features: KtxRuntimeFeature[];
    force?: boolean;
  }) => Promise<ManagedPythonDaemonStartResult>;
  stopDaemon?: (options: { cliVersion: string }) => Promise<ManagedPythonDaemonStopResult>;
  stopAllDaemons?: (options: { cliVersion: string }) => Promise<ManagedPythonDaemonStopAllResult>;
  readStatus?: (options: ManagedPythonRuntimeLayoutOptions) => Promise<ManagedPythonRuntimeStatus>;
  doctorRuntime?: (options: ManagedPythonRuntimeLayoutOptions) => Promise<ManagedPythonRuntimeDoctorCheck[]>;
  pruneRuntime?: (options: {
    cliVersion: string;
    runtimeRoot: string;
    dryRun?: boolean;
  }) => Promise<ManagedPythonRuntimePruneResult>;
}

function writeJson(io: KtxCliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeInstallResult(io: KtxCliIo, result: ManagedPythonRuntimeInstallResult): void {
  const verb = result.status === 'ready' ? 'Using existing' : 'Installed';
  io.stdout.write(`${verb} KTX Python runtime\n`);
  io.stdout.write(`version: ${result.manifest.cliVersion}\n`);
  io.stdout.write(`features: ${result.manifest.features.join(', ')}\n`);
  io.stdout.write(`python: ${result.manifest.python.executable}\n`);
  io.stdout.write(`daemon: ${result.manifest.python.daemonExecutable}\n`);
  io.stdout.write(`manifest: ${result.layout.manifestPath}\n`);
  io.stdout.write(`install log: ${result.layout.installLogPath}\n`);
}

function writeDaemonStart(io: KtxCliIo, result: ManagedPythonDaemonStartResult): void {
  const verb = result.status === 'reused' ? 'Using existing' : 'Started';
  io.stdout.write(`${verb} KTX Python daemon\n`);
  io.stdout.write(`url: ${result.baseUrl}\n`);
  io.stdout.write(`pid: ${result.state.pid}\n`);
  io.stdout.write(`version: ${result.state.version}\n`);
  io.stdout.write(`features: ${result.state.features.join(', ')}\n`);
  io.stdout.write(`state: ${result.layout.daemonStatePath}\n`);
  io.stdout.write(`stdout: ${result.state.stdoutLog}\n`);
  io.stdout.write(`stderr: ${result.state.stderrLog}\n`);
}

function writeDaemonStop(io: KtxCliIo, result: ManagedPythonDaemonStopResult): void {
  if (result.status === 'already-stopped') {
    io.stdout.write('KTX Python daemon already stopped\n');
    return;
  }
  io.stdout.write('Stopped KTX Python daemon\n');
  io.stdout.write(`pid: ${result.state?.pid ?? 'unknown'}\n`);
  io.stdout.write(`state: ${result.layout.daemonStatePath}\n`);
}

function writeStopAllEntry(io: KtxCliIo, entry: { pid: number; source: string; url?: string; health?: string; detail?: string }): void {
  io.stdout.write(
    `pid: ${entry.pid} source: ${entry.source}${entry.url ? ` url: ${entry.url}` : ''}${
      entry.health ? ` health: ${entry.health}` : ''
    }${
      entry.detail ? ` detail: ${entry.detail}` : ''
    }\n`,
  );
}

function writeDaemonStopAll(io: KtxCliIo, result: ManagedPythonDaemonStopAllResult): number {
  const failed = result.failed.length + result.scanErrors.length;
  if (
    result.stopped.length === 0 &&
    result.stale.length === 0 &&
    result.failed.length === 0 &&
    result.scanErrors.length === 0
  ) {
    io.stdout.write('No KTX Python daemons found\n');
    return 0;
  }
  if (failed === 0) {
    io.stdout.write(`Stopped ${result.stopped.length} KTX Python daemons\n`);
    if (result.stale.length > 0) {
      io.stdout.write(`Cleaned ${result.stale.length} stale daemon states\n`);
    }
    for (const entry of result.stopped) {
      writeStopAllEntry(io, entry);
    }
    for (const entry of result.stale) {
      writeStopAllEntry(io, entry);
    }
    return 0;
  }
  io.stderr.write(
    `Stopped ${result.stopped.length} KTX Python daemons; failed ${result.failed.length}${
      result.stale.length > 0 ? `; cleaned stale ${result.stale.length}` : ''
    }\n`,
  );
  for (const entry of result.failed) {
    io.stderr.write(
      `pid: ${entry.pid} source: ${entry.source}${entry.url ? ` url: ${entry.url}` : ''}${
        entry.health ? ` health: ${entry.health}` : ''
      } detail: ${entry.detail}\n`,
    );
  }
  for (const error of result.scanErrors) {
    io.stderr.write(`process scan: ${error}\n`);
  }
  return 1;
}

function writeStatus(io: KtxCliIo, status: ManagedPythonRuntimeStatus): void {
  io.stdout.write('KTX Python runtime\n');
  io.stdout.write(`status: ${status.kind}\n`);
  io.stdout.write(`detail: ${status.detail}\n`);
  io.stdout.write(`runtime root: ${status.layout.runtimeRoot}\n`);
  io.stdout.write(`version dir: ${status.layout.versionDir}\n`);
  if (status.manifest) {
    io.stdout.write(`features: ${status.manifest.features.join(', ')}\n`);
    io.stdout.write(`python: ${status.manifest.python.executable}\n`);
    io.stdout.write(`daemon: ${status.manifest.python.daemonExecutable}\n`);
  }
}

function writeDoctor(io: KtxCliIo, checks: ManagedPythonRuntimeDoctorCheck[]): void {
  io.stdout.write('KTX Python runtime doctor\n');
  for (const check of checks) {
    io.stdout.write(`${check.status.toUpperCase()} ${check.label}: ${check.detail}\n`);
    if (check.fix) {
      io.stdout.write(`     Fix: ${check.fix}\n`);
    }
  }
}

function writePrune(io: KtxCliIo, result: ManagedPythonRuntimePruneResult, dryRun: boolean): void {
  if (result.stale.length === 0) {
    io.stdout.write(`No stale KTX Python runtimes found under ${result.runtimeRoot}\n`);
    return;
  }
  io.stdout.write(dryRun ? 'Stale KTX Python runtimes\n' : 'Removed stale KTX Python runtimes\n');
  for (const path of dryRun ? result.stale : result.removed) {
    io.stdout.write(`${path}\n`);
  }
}

export async function runKtxRuntime(
  args: KtxRuntimeArgs,
  io: KtxCliIo = process,
  deps: KtxRuntimeDeps = {},
): Promise<number> {
  try {
    if (args.command === 'install') {
      const installRuntime = deps.installRuntime ?? installManagedPythonRuntime;
      const result = await installRuntime({
        cliVersion: args.cliVersion,
        features: [args.feature],
        force: args.force,
      });
      writeInstallResult(io, result);
      return 0;
    }
    if (args.command === 'start') {
      const startDaemon = deps.startDaemon ?? startManagedPythonDaemon;
      const result = await startDaemon({
        cliVersion: args.cliVersion,
        features: [args.feature],
        force: args.force,
      });
      writeDaemonStart(io, result);
      return 0;
    }
    if (args.command === 'stop') {
      if (args.all) {
        const stopAllDaemons = deps.stopAllDaemons ?? stopAllManagedPythonDaemons;
        const result = await stopAllDaemons({ cliVersion: args.cliVersion });
        return writeDaemonStopAll(io, result);
      } else {
        const stopDaemon = deps.stopDaemon ?? stopManagedPythonDaemon;
        const result = await stopDaemon({ cliVersion: args.cliVersion });
        writeDaemonStop(io, result);
        return 0;
      }
    }
    if (args.command === 'status') {
      const readStatus = deps.readStatus ?? readManagedPythonRuntimeStatus;
      const status = await readStatus({ cliVersion: args.cliVersion });
      if (args.json) {
        writeJson(io, status);
      } else {
        writeStatus(io, status);
      }
      return 0;
    }
    if (args.command === 'doctor') {
      const doctorRuntime = deps.doctorRuntime ?? doctorManagedPythonRuntime;
      const checks = await doctorRuntime({ cliVersion: args.cliVersion });
      if (args.json) {
        writeJson(io, { checks });
      } else {
        writeDoctor(io, checks);
      }
      return checks.some((check) => check.status === 'fail') ? 1 : 0;
    }
    if (!args.dryRun && !args.yes) {
      io.stderr.write('Refusing to prune without --yes. Preview with: ktx runtime prune --dry-run\n');
      return 1;
    }
    const status = await (deps.readStatus ?? readManagedPythonRuntimeStatus)({ cliVersion: args.cliVersion });
    const pruneRuntime = deps.pruneRuntime ?? pruneManagedPythonRuntimes;
    const result = await pruneRuntime({
      cliVersion: args.cliVersion,
      runtimeRoot: status.layout.runtimeRoot,
      dryRun: args.dryRun,
    });
    writePrune(io, result, args.dryRun);
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
