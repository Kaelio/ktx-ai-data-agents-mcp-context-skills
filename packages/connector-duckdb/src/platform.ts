import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type DuckDbLibc = 'glibc' | 'musl' | 'unknown';

export interface DuckDbPlatformInfo {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  libc: DuckDbLibc;
}

export function detectDuckDbLibc(): DuckDbLibc {
  const report = process.report?.getReport?.();
  const header = (report as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
  if (header?.glibcVersionRuntime) return 'glibc';
  if (process.platform === 'linux') {
    const muslLoaderHints = [
      '/lib/ld-musl-x86_64.so.1',
      '/lib/ld-musl-aarch64.so.1',
      join('/usr', 'bin', 'ldd'),
    ];
    if (
      muslLoaderHints.some((path) => {
        if (!existsSync(path)) return false;
        if (path.includes('musl')) return true;
        try {
          return readFileSync(path, 'utf-8').includes('musl');
        } catch {
          return false;
        }
      })
    ) {
      return 'musl';
    }
  }
  return 'unknown';
}

export function currentDuckDbPlatform(): DuckDbPlatformInfo {
  return { platform: process.platform, arch: process.arch, libc: detectDuckDbLibc() };
}

export function assertSupportedDuckDbPlatform(info: DuckDbPlatformInfo = currentDuckDbPlatform()): void {
  const supported =
    (info.platform === 'darwin' && (info.arch === 'arm64' || info.arch === 'x64')) ||
    (info.platform === 'win32' && (info.arch === 'arm64' || info.arch === 'x64')) ||
    (info.platform === 'linux' && (info.arch === 'arm64' || info.arch === 'x64') && info.libc !== 'musl');
  if (!supported) {
    throw new Error(
      `DuckDB native bindings are not supported on ${info.platform} ${info.arch} ${info.libc}. ` +
        'KTX DuckDB v1 supports macOS arm64/x64, Windows arm64/x64, and Linux glibc arm64/x64.',
    );
  }
}

export function formatDuckDbNativeLoadError(error: unknown, info = currentDuckDbPlatform()): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `@duckdb/node-api native bindings could not be loaded for ${info.platform} ${info.arch} ${info.libc}. ` +
      `Install optional dependencies for @duckdb/node-api or use a supported platform. ${detail}`,
  );
}
