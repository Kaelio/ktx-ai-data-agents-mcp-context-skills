import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

export const runtimeFeatureSchema = z.enum(['core', 'local-embeddings']);
export type KtxRuntimeFeature = z.infer<typeof runtimeFeatureSchema>;

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

export interface ManagedPythonRuntimePruneResult {
  runtimeRoot: string;
  stale: string[];
  kept: string[];
  removed: string[];
}

export const MISSING_UV_RUNTIME_INSTALL_MESSAGE =
  'uv is required to install the KTX Python runtime. KTX does not download uv automatically. Install uv, make sure it is on PATH, and retry: ktx runtime install --yes';

function defaultAssetDir(): string {
  return fileURLToPath(new URL('../assets/python/', import.meta.url));
}

function runtimeRootFor(input: Required<Pick<ManagedPythonRuntimeLayoutOptions, 'platform' | 'env' | 'homeDir'>>): string {
  if (input.env.KTX_RUNTIME_ROOT) {
    return input.env.KTX_RUNTIME_ROOT;
  }
  if (input.platform === 'darwin') {
    return join(input.homeDir, 'Library', 'Application Support', 'kaelio', 'ktx', 'runtime');
  }
  if (input.platform === 'win32') {
    return join(input.env.LOCALAPPDATA ?? join(input.homeDir, 'AppData', 'Local'), 'Kaelio', 'KTX', 'runtime');
  }
  return join(input.env.XDG_DATA_HOME ?? join(input.homeDir, '.local', 'share'), 'kaelio', 'ktx', 'runtime');
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
  const runtimeRoot = options.runtimeRoot ?? runtimeRootFor({ platform, env, homeDir });
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
    daemonStatePath: join(versionDir, 'daemon.json'),
    daemonStdoutPath: join(versionDir, 'daemon.stdout.log'),
    daemonStderrPath: join(versionDir, 'daemon.stderr.log'),
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

export async function verifyRuntimeAsset(input: { assetDir: string }): Promise<ManagedRuntimeAsset> {
  const manifestPath = join(input.assetDir, 'manifest.json');
  const manifest = runtimeAssetManifestSchema.parse(await readJsonFile(manifestPath));
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
}): Promise<{ stdout: string; stderr: string }> {
  await appendFile(input.logPath, `$ ${input.command} ${input.args.join(' ')}\n`);
  try {
    const result = await input.exec(input.command, input.args, { cwd: input.cwd });
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

async function ensureUv(exec: ManagedPythonRuntimeExec): Promise<string> {
  try {
    const result = await exec('uv', ['--version']);
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
  await ensureUv(exec);
  await runLogged({ exec, logPath: layout.installLogPath, command: 'uv', args: ['venv', layout.venvDir] });
  const wheelSpec = features.includes('local-embeddings') ? `${asset.wheelPath}[local-embeddings]` : asset.wheelPath;
  await runLogged({
    exec,
    logPath: layout.installLogPath,
    command: 'uv',
    args: ['pip', 'install', '--python', layout.pythonPath, wheelSpec],
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
    const version = await ensureUv(exec);
    checks.push(check('pass', { id: 'uv', label: 'uv', detail: version }));
  } catch (error) {
    checks.push(
      check('fail', {
        id: 'uv',
        label: 'uv',
        detail: error instanceof Error ? error.message : String(error),
        fix: 'Install uv, make sure it is on PATH, and run: ktx runtime install --yes',
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
      ...(status.kind === 'ready' ? {} : { fix: 'Run: ktx runtime install --yes' }),
    }),
  );
  return checks;
}

export async function pruneManagedPythonRuntimes(options: {
  cliVersion: string;
  runtimeRoot: string;
  dryRun?: boolean;
}): Promise<ManagedPythonRuntimePruneResult> {
  if (!(await pathExists(options.runtimeRoot))) {
    return { runtimeRoot: options.runtimeRoot, stale: [], kept: [], removed: [] };
  }
  const entries = await readdir(options.runtimeRoot);
  const stale: string[] = [];
  const kept: string[] = [];
  for (const entry of entries) {
    const path = join(options.runtimeRoot, entry);
    const info = await stat(path);
    if (!info.isDirectory()) {
      continue;
    }
    if (entry === options.cliVersion) {
      kept.push(path);
    } else {
      stale.push(path);
    }
  }
  const removed: string[] = [];
  if (options.dryRun !== true) {
    for (const path of stale) {
      await rm(path, { recursive: true, force: true });
      removed.push(path);
    }
  }
  return { runtimeRoot: options.runtimeRoot, stale, kept, removed };
}
