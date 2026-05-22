import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import snowflake from 'snowflake-sdk';

let configuredLogFilePath: string | null = null;

/**
 * Redirects the snowflake-sdk logger to a project-scoped file so its JSON output
 * does not bleed into the CLI's TTY (which would pollute the setup wizard and
 * break the in-place progress repainter in `context-build-view.ts`).
 *
 * Idempotent per process: re-calling with the same projectDir is a no-op.
 */
export function configureSnowflakeSdkLogger(projectDir: string): string {
  const logDir = resolve(projectDir, '.ktx', 'logs');
  const logFilePath = resolve(logDir, 'snowflake.log');
  if (configuredLogFilePath === logFilePath) {
    return logFilePath;
  }
  mkdirSync(logDir, { recursive: true });
  snowflake.configure({
    logFilePath,
    additionalLogToConsole: false,
  });
  configuredLogFilePath = logFilePath;
  return logFilePath;
}

/** @internal */
export function resetSnowflakeSdkLoggerConfigurationForTests(): void {
  configuredLogFilePath = null;
}
