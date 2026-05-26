import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { configure } = vi.hoisted(() => ({ configure: vi.fn() }));
vi.mock('snowflake-sdk', () => ({
  default: { configure },
}));

import {
  configureSnowflakeSdkLogger,
  resetSnowflakeSdkLoggerConfigurationForTests,
} from '../../../src/connectors/snowflake/sdk-logger.js';

describe('configureSnowflakeSdkLogger', () => {
  let projectDir: string;

  beforeEach(() => {
    configure.mockReset();
    resetSnowflakeSdkLoggerConfigurationForTests();
    projectDir = mkdtempSync(join(tmpdir(), 'ktx-snowflake-logger-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('routes logs to <projectDir>/.ktx/logs/snowflake.log with console output disabled', () => {
    const expected = resolve(projectDir, '.ktx', 'logs', 'snowflake.log');
    const returned = configureSnowflakeSdkLogger(projectDir);
    expect(returned).toBe(expected);
    expect(configure).toHaveBeenCalledTimes(1);
    expect(configure).toHaveBeenCalledWith({
      logFilePath: expected,
      additionalLogToConsole: false,
    });
    expect(statSync(resolve(projectDir, '.ktx', 'logs')).isDirectory()).toBe(true);
  });

  it('is idempotent for the same projectDir', () => {
    configureSnowflakeSdkLogger(projectDir);
    configureSnowflakeSdkLogger(projectDir);
    expect(configure).toHaveBeenCalledTimes(1);
  });

  it('reconfigures when projectDir changes', () => {
    const other = mkdtempSync(join(tmpdir(), 'ktx-snowflake-logger-other-'));
    try {
      configureSnowflakeSdkLogger(projectDir);
      configureSnowflakeSdkLogger(other);
      expect(configure).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
