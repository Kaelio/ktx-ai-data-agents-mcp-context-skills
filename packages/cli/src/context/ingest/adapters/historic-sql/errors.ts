import type { HistoricSqlDialect } from './types.js';

interface HistoricSqlGrantsMissingErrorOptions {
  dialect: HistoricSqlDialect;
  message: string;
  remediation: string;
  cause?: unknown;
}

export class HistoricSqlGrantsMissingError extends Error {
  readonly dialect: HistoricSqlDialect;
  readonly remediation: string;

  constructor(options: HistoricSqlGrantsMissingErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HistoricSqlGrantsMissingError';
    this.dialect = options.dialect;
    this.remediation = options.remediation;
  }
}

interface HistoricSqlExtensionMissingErrorOptions {
  dialect: HistoricSqlDialect;
  message: string;
  remediation: string;
  cause?: unknown;
}

export class HistoricSqlExtensionMissingError extends Error {
  readonly dialect: HistoricSqlDialect;
  readonly remediation: string;

  constructor(options: HistoricSqlExtensionMissingErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HistoricSqlExtensionMissingError';
    this.dialect = options.dialect;
    this.remediation = options.remediation;
  }
}

interface HistoricSqlVersionUnsupportedErrorOptions {
  dialect: HistoricSqlDialect;
  detectedVersion: string;
  minimumVersion: string;
}

export class HistoricSqlVersionUnsupportedError extends Error {
  readonly dialect: HistoricSqlDialect;
  readonly detectedVersion: string;
  readonly minimumVersion: string;

  constructor(options: HistoricSqlVersionUnsupportedErrorOptions) {
    super(
      `Unsupported ${options.dialect} version for historic-SQL ingest: detected ${options.detectedVersion}; requires ${options.minimumVersion} or newer.`,
    );
    this.name = 'HistoricSqlVersionUnsupportedError';
    this.dialect = options.dialect;
    this.detectedVersion = options.detectedVersion;
    this.minimumVersion = options.minimumVersion;
  }
}
