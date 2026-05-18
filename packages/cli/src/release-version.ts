import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertReleaseVersion(value: unknown, source: string): string {
  if (typeof value !== 'string' || !semverPattern.test(value)) {
    throw new Error(`Invalid KTX release version in ${source}`);
  }
  return value;
}

function findReleasePolicyPath(startDir: string): string | undefined {
  let current = startDir;
  const root = parse(current).root;
  while (true) {
    const candidate = join(current, 'release-policy.json');
    if (existsSync(candidate)) {
      return candidate;
    }
    if (current === root) {
      return undefined;
    }
    current = dirname(current);
  }
}

function readSourceReleaseVersion(startDir = dirname(fileURLToPath(import.meta.url))): string | undefined {
  const policyPath = findReleasePolicyPath(startDir);
  if (!policyPath) {
    return undefined;
  }
  const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as unknown;
  if (!isPlainObject(policy)) {
    throw new Error(`Invalid KTX release policy: ${policyPath}`);
  }
  return assertReleaseVersion(policy.publicNpmPackageVersion, policyPath);
}

export function resolveKtxRuntimeVersion(input: {
  packageName: string;
  packageVersion: string;
  startDir?: string;
}): string {
  if (input.packageName === '@kaelio/ktx') {
    return assertReleaseVersion(input.packageVersion, `${input.packageName}/package.json`);
  }
  return readSourceReleaseVersion(input.startDir) ?? input.packageVersion;
}
