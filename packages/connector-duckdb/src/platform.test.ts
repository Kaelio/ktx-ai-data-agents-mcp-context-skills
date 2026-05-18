import { describe, expect, it } from 'vitest';
import { assertSupportedDuckDbPlatform, formatDuckDbNativeLoadError } from './platform.js';

describe('DuckDB native platform guard', () => {
  it('rejects Linux musl before native loading', () => {
    expect(() =>
      assertSupportedDuckDbPlatform({ platform: 'linux', arch: 'x64', libc: 'musl' }),
    ).toThrow('DuckDB native bindings are not supported on linux x64 musl');
  });

  it('accepts macOS arm64', () => {
    expect(() =>
      assertSupportedDuckDbPlatform({ platform: 'darwin', arch: 'arm64', libc: 'unknown' }),
    ).not.toThrow();
  });

  it('formats missing optional binary errors with platform details', () => {
    const error = formatDuckDbNativeLoadError(
      new Error("Cannot find module '@duckdb/node-bindings-darwin-arm64'"),
      { platform: 'darwin', arch: 'arm64', libc: 'unknown' },
    );
    expect(error.message).toContain('@duckdb/node-api native bindings could not be loaded');
    expect(error.message).toContain('darwin arm64');
  });
});
