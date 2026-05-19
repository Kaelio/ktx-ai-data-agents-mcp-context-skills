import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

export const runtimeFeatureSchema = z.enum(['core', 'local-embeddings']);
export type KtxRuntimeFeature = z.infer<typeof runtimeFeatureSchema>;

/**
 * Python version the managed runtime venv must be built with. KTX's bundled
 * wheels declare `requires-python = ">=3.13"`; without an explicit `--python`
 * flag, `uv venv` may pick a too-old system Python (Ubuntu 24.04 ships 3.12)
 * and the subsequent `uv pip install` fails late with a confusing "package
 * requires Python >=3.13" error. Pinning here pushes uv to auto-download the
 * right interpreter via its python-management feature.
 */
export const MANAGED_RUNTIME_PYTHON_VERSION = '3.13';

const runtimeAssetManifestSchema = z.object({
  schemaVersion: z.literal(1),
  distributionName: z.literal('kaelio-ktx'),
  normalizedName: z.literal('kaelio_ktx'),
  version: z.string().min(1),
  wheel: z.object({
    file: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
  }),
});

export type KtxRuntimeAssetManifest = z.infer<typeof runtimeAssetManifestSchema>;

const installedRuntimeManifestSchema = z.object({
  schemaVersion: z.literal(1),
  cliVersion: z.string().min(1),
  installedAt: z.string().min(1),
  asset: runtimeAssetManifestSchema,
  features: z.array(runtimeFeatureSchema).min(1),
  python: z.object({
    executable: z.string().min(1),
    daemonExecutable: z.string().min(1),
  }),
  installLog: z.string().min(1),
});

export type InstalledKtxRuntimeManifest = z.infer<typeof installedRuntimeManifestSchema>;

export interface ManagedPythonRuntimeLayoutOptions {
  cliVersion: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  runtimeRoot?: string;
  assetDir?: string;
}

export interface ManagedPythonRuntimeLayout {
  cliVersion: string;
  runtimeRoot: string;
  versionDir: string;
  venvDir: string;
  manifestPath: string;
  installLogPath: string;
  assetDir: string;
  assetManifestPath: string;
  pythonPath: string;
  daemonPath: string;
}

export interface ManagedPythonDaemonLayoutOptions extends ManagedPythonRuntimeLayoutOptions {
  projectDir: string;
}

export interface ManagedPythonDaemonLayout extends ManagedPythonRuntimeLayout {
  projectDir: string;
  daemonStateDir: string;
  daemonStatePath: string;
  daemonStdoutPath: string;
  daemonStderrPath: string;
}

export interface ManagedRuntimeAsset {
  manifest: KtxRuntimeAssetManifest;
  wheelPath: string;
}

export type ManagedPythonRuntimeExec = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export interface ManagedPythonRuntimeInstallOptions extends ManagedPythonRuntimeLayoutOptions {
  features: KtxRuntimeFeature[];
  force?: boolean;
  exec?: ManagedPythonRuntimeExec;
}

export interface ManagedPythonRuntimeInstallResult {
  status: 'ready' | 'installed';
  layout: ManagedPythonRuntimeLayout;
  asset: ManagedRuntimeAsset;
  manifest: InstalledKtxRuntimeManifest;
}

export type ManagedPythonRuntimeStatusKind = 'missing' | 'ready' | 'mismatched' | 'broken';

export interface ManagedPythonRuntimeStatus {
  kind: ManagedPythonRuntimeStatusKind;
  detail: string;
  layout: ManagedPythonRuntimeLayout;
  manifest?: InstalledKtxRuntimeManifest;
}

export interface ManagedPythonRuntimeDoctorCheck {
  id: 'uv' | 'asset' | 'runtime';
  label: string;
  status: 'pass' | 'fail';
  detail: string;
  fix?: string;
}

export const MISSING_UV_RUNTIME_INSTALL_MESSAGE =
  'uv is required to install the KTX Python runtime. KTX does not download uv automatically. Install uv, make sure it is on PATH, and retry: ktx dev runtime install --yes';

function defaultAssetDir(): string {
  return fileURLToPath(new URL('../assets/python/', import.meta.url));
}

function runtimeRootFor(input: { env: NodeJS.ProcessEnv; homeDir: string }): string {
  if (input.env.KTX_RUNTIME_ROOT) {
    return input.env.KTX_RUNTIME_ROOT;
  }
  return join(input.homeDir, '.ktx', 'runtime');
}

function executablePath(venvDir: string, platform: NodeJS.Platform, name: string): string {
  if (platform === 'win32') {
    return join(venvDir, 'Scripts', `${name}.exe`);
  }
  return join(venvDir, 'bin', name);
}

export function managedPythonRuntimeLayout(options: ManagedPythonRuntimeLayoutOptions): ManagedPythonRuntimeLayout {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const runtimeRoot = options.runtimeRoot ?? runtimeRootFor({ env, homeDir });
  const versionDir = join(runtimeRoot, options.cliVersion);
  const venvDir = join(versionDir, '.venv');
  const assetDir = options.assetDir ?? defaultAssetDir();

  return {
    cliVersion: options.cliVersion,
    runtimeRoot,
    versionDir,
    venvDir,
    manifestPath: join(versionDir, 'manifest.json'),
    installLogPath: join(versionDir, 'install.log'),
    assetDir,
    assetManifestPath: join(assetDir, 'manifest.json'),
    pythonPath: executablePath(venvDir, platform, 'python'),
    daemonPath: executablePath(venvDir, platform, 'ktx-daemon'),
  };
}

export function managedPythonDaemonLayout(options: ManagedPythonDaemonLayoutOptions): ManagedPythonDaemonLayout {
  const runtime = managedPythonRuntimeLayout(options);
  const daemonStateDir = join(options.projectDir, '.ktx', 'runtime');
  return {
    ...runtime,
    projectDir: options.projectDir,
    daemonStateDir,
    daemonStatePath: join(daemonStateDir, 'daemon.json'),
    daemonStdoutPath: join(daemonStateDir, 'daemon.stdout.log'),
    daemonStderrPath: join(daemonStateDir, 'daemon.stderr.log'),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assertSafeWheelFilename(file: string): void {
  if (file !== basename(file) || file.includes('/') || file.includes('\\')) {
    throw new Error(`Unsafe runtime wheel filename in bundled manifest: ${file}`);
  }
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function isErrnoException(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export async function verifyRuntimeAsset(input: { assetDir: string }): Promise<ManagedRuntimeAsset> {
  const manifestPath = join(input.assetDir, 'manifest.json');
  let manifestData: unknown;
  try {
    manifestData = await readJsonFile(manifestPath);
  } catch (error) {
    if (isErrnoException(error, 'ENOENT')) {
      throw new Error(
        [
          `Missing bundled Python runtime manifest: ${manifestPath}`,
          'In a source checkout, build the local runtime assets with: pnpm run artifacts:build',
          'Then retry the runtime-backed KTX command.',
        ].join('\n'),
      );
    }
    throw error;
  }
  const manifest = runtimeAssetManifestSchema.parse(manifestData);
  assertSafeWheelFilename(manifest.wheel.file);
  const wheelPath = join(input.assetDir, manifest.wheel.file);
  const wheel = await readFile(wheelPath);
  const sha256 = createHash('sha256').update(wheel).digest('hex');
  if (sha256 !== manifest.wheel.sha256 || wheel.byteLength !== manifest.wheel.bytes) {
    throw new Error(`Bundled Python runtime wheel checksum mismatch: ${wheelPath}`);
  }
  return { manifest, wheelPath };
}

function normalizeFeatures(features: KtxRuntimeFeature[]): KtxRuntimeFeature[] {
  const requested = new Set<KtxRuntimeFeature>(['core', ...features]);
  return runtimeFeatureSchema.options.filter((feature) => requested.has(feature));
}

async function readInstalledManifest(path: string): Promise<InstalledKtxRuntimeManifest | undefined> {
  if (!(await pathExists(path))) {
    return undefined;
  }
  return installedRuntimeManifestSchema.parse(await readJsonFile(path));
}

function hasFeatures(manifest: InstalledKtxRuntimeManifest, features: KtxRuntimeFeature[]): boolean {
  return normalizeFeatures(features).every((feature) => manifest.features.includes(feature));
}

async function defaultExec(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function errorOutput(error: unknown): { stdout: string; stderr: string } {
  const value = error as { stdout?: unknown; stderr?: unknown };
  return {
    stdout: typeof value.stdout === 'string' ? value.stdout : '',
    stderr: typeof value.stderr === 'string' ? value.stderr : '',
  };
}

async function runLogged(input: {
  exec: ManagedPythonRuntimeExec;
  logPath: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ stdout: string; stderr: string }> {
  await appendFile(input.logPath, `$ ${input.command} ${input.args.join(' ')}\n`);
  try {
    const result = await input.exec(input.command, input.args, { cwd: input.cwd, env: input.env });
    if (result.stdout) {
      await appendFile(input.logPath, result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
    }
    if (result.stderr) {
      await appendFile(input.logPath, result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
    }
    return result;
  } catch (error) {
    const output = errorOutput(error);
    if (output.stdout) {
      await appendFile(input.logPath, output.stdout.endsWith('\n') ? output.stdout : `${output.stdout}\n`);
    }
    if (output.stderr) {
      await appendFile(input.logPath, output.stderr.endsWith('\n') ? output.stderr : `${output.stderr}\n`);
    }
    throw new Error(`Python runtime install failed. Install log: ${input.logPath}`);
  }
}

function managedRuntimeUvEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...baseEnv, UV_NO_CONFIG: '1' };
}

async function ensureUv(exec: ManagedPythonRuntimeExec, env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const result = await exec('uv', ['--version'], { env });
    return result.stdout.trim() || 'uv available';
  } catch {
    throw new Error(MISSING_UV_RUNTIME_INSTALL_MESSAGE);
  }
}

export async function installManagedPythonRuntime(
  options: ManagedPythonRuntimeInstallOptions,
): Promise<ManagedPythonRuntimeInstallResult> {
  const layout = managedPythonRuntimeLayout(options);
  const exec = options.exec ?? defaultExec;
  const features = normalizeFeatures(options.features);
  const asset = await verifyRuntimeAsset({ assetDir: layout.assetDir });
  const uvEnv = managedRuntimeUvEnv(options.env ?? process.env);
  const existing = await readInstalledManifest(layout.manifestPath);
  if (
    options.force !== true &&
    existing &&
    existing.cliVersion === options.cliVersion &&
    existing.asset.wheel.sha256 === asset.manifest.wheel.sha256 &&
    hasFeatures(existing, features) &&
    (await pathExists(existing.python.executable)) &&
    (await pathExists(existing.python.daemonExecutable))
  ) {
    return { status: 'ready', layout, asset, manifest: existing };
  }

  await rm(layout.versionDir, { recursive: true, force: true });
  await mkdir(layout.versionDir, { recursive: true });
  await writeFile(layout.installLogPath, '');
  await ensureUv(exec, uvEnv);
  await runLogged({
    exec,
    logPath: layout.installLogPath,
    command: 'uv',
    args: ['venv', layout.venvDir, '--python', MANAGED_RUNTIME_PYTHON_VERSION],
    env: uvEnv,
  });
  const wheelSpec = features.includes('local-embeddings') ? `${asset.wheelPath}[local-embeddings]` : asset.wheelPath;
  await runLogged({
    exec,
    logPath: layout.installLogPath,
    command: 'uv',
    args: ['pip', 'install', '--python', layout.pythonPath, wheelSpec],
    env: uvEnv,
  });

  const manifest: InstalledKtxRuntimeManifest = {
    schemaVersion: 1,
    cliVersion: options.cliVersion,
    installedAt: new Date().toISOString(),
    asset: asset.manifest,
    features,
    python: {
      executable: layout.pythonPath,
      daemonExecutable: layout.daemonPath,
    },
    installLog: layout.installLogPath,
  };
  await writeFile(layout.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { status: 'installed', layout, asset, manifest };
}

export async function readManagedPythonRuntimeStatus(
  options: ManagedPythonRuntimeLayoutOptions,
): Promise<ManagedPythonRuntimeStatus> {
  const layout = managedPythonRuntimeLayout(options);
  let manifest: InstalledKtxRuntimeManifest | undefined;
  try {
    manifest = await readInstalledManifest(layout.manifestPath);
  } catch (error) {
    return {
      kind: 'broken',
      detail: `Runtime manifest is invalid: ${error instanceof Error ? error.message : String(error)}`,
      layout,
    };
  }
  if (!manifest) {
    return { kind: 'missing', detail: `No runtime manifest at ${layout.manifestPath}`, layout };
  }
  if (manifest.cliVersion !== options.cliVersion) {
    return {
      kind: 'mismatched',
      detail: `Runtime is for CLI ${manifest.cliVersion}, current CLI is ${options.cliVersion}`,
      layout,
      manifest,
    };
  }
  if (!(await pathExists(manifest.python.executable))) {
    return { kind: 'broken', detail: `Missing Python executable: ${manifest.python.executable}`, layout, manifest };
  }
  if (!(await pathExists(manifest.python.daemonExecutable))) {
    return { kind: 'broken', detail: `Missing ktx-daemon executable: ${manifest.python.daemonExecutable}`, layout, manifest };
  }
  return { kind: 'ready', detail: `Runtime ready at ${layout.versionDir}`, layout, manifest };
}

function check(
  status: ManagedPythonRuntimeDoctorCheck['status'],
  input: Omit<ManagedPythonRuntimeDoctorCheck, 'status'>,
): ManagedPythonRuntimeDoctorCheck {
  return { status, ...input };
}

export async function doctorManagedPythonRuntime(
  options: ManagedPythonRuntimeLayoutOptions & { exec?: ManagedPythonRuntimeExec },
): Promise<ManagedPythonRuntimeDoctorCheck[]> {
  const exec = options.exec ?? defaultExec;
  const checks: ManagedPythonRuntimeDoctorCheck[] = [];
  try {
    const version = await ensureUv(exec, managedRuntimeUvEnv(options.env ?? process.env));
    checks.push(check('pass', { id: 'uv', label: 'uv', detail: version }));
  } catch (error) {
    checks.push(
      check('fail', {
        id: 'uv',
        label: 'uv',
        detail: error instanceof Error ? error.message : String(error),
        fix: 'Install uv, make sure it is on PATH, and run: ktx dev runtime install --yes',
      }),
    );
  }

  try {
    const asset = await verifyRuntimeAsset({ assetDir: managedPythonRuntimeLayout(options).assetDir });
    checks.push(check('pass', { id: 'asset', label: 'Bundled Python wheel', detail: asset.wheelPath }));
  } catch (error) {
    checks.push(
      check('fail', {
        id: 'asset',
        label: 'Bundled Python wheel',
        detail: error instanceof Error ? error.message : String(error),
        fix: 'Run: pnpm run artifacts:check',
      }),
    );
  }

  const status = await readManagedPythonRuntimeStatus(options);
  checks.push(
    check(status.kind === 'ready' ? 'pass' : 'fail', {
      id: 'runtime',
      label: 'Managed Python runtime',
      detail: status.detail,
      ...(status.kind === 'ready' ? {} : { fix: 'Run: ktx dev runtime install --yes' }),
    }),
  );
  return checks;
}
