import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import {
  createDaemonLookerTableIdentifierParser,
  type DaemonLiveDatabaseIntrospectionOptions,
  type KtxDaemonDatabaseHttpJsonRunner,
  type KtxDaemonTableIdentifierHttpJsonRunner,
  type LookerTableIdentifierParser,
} from '@ktx/context/ingest';
import {
  createHttpSqlAnalysisPort,
  type KtxSqlAnalysisHttpJsonRunner,
  type SqlAnalysisPort,
} from '@ktx/context/sql-analysis';
import type { KtxCliIo } from './cli-runtime.js';
import {
  ensureManagedPythonCommandRuntime,
  type KtxManagedPythonInstallPolicy,
  type ManagedPythonCommandRuntime,
} from './managed-python-command.js';
import { startManagedPythonDaemon, type ManagedPythonDaemonStartResult } from './managed-python-daemon.js';

export type ManagedPythonHttpJsonRunner = (
  path: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export type ManagedPythonHttpPostJson = (
  baseUrl: string,
  path: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export interface ManagedPythonCoreDaemonOptions {
  cliVersion: string;
  installPolicy: KtxManagedPythonInstallPolicy;
  io: KtxCliIo;
  ensureRuntime?: (options: {
    cliVersion: string;
    installPolicy: KtxManagedPythonInstallPolicy;
    io: KtxCliIo;
    feature: 'core';
  }) => Promise<ManagedPythonCommandRuntime>;
  startDaemon?: (options: {
    cliVersion: string;
    features: ['core'];
    force: false;
  }) => Promise<ManagedPythonDaemonStartResult>;
}

export type ManagedPythonDaemonHttpOptions =
  | {
      requestJson: ManagedPythonHttpJsonRunner;
    }
  | {
      resolveBaseUrl: () => Promise<string>;
      postJson?: ManagedPythonHttpPostJson;
    }
  | (ManagedPythonCoreDaemonOptions & {
      postJson?: ManagedPythonHttpPostJson;
    });

function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function parseJsonObject(raw: string, path: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`KTX managed daemon HTTP ${path} returned non-object JSON`);
  }
  return parsed as Record<string, unknown>;
}

export async function postManagedDaemonJson(
  baseUrl: string,
  path: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const target = new URL(path.replace(/^\//, ''), normalizedBaseUrl(baseUrl));
    const body = JSON.stringify(payload);
    const client = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = client(
      target,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const statusCode = response.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`KTX managed daemon HTTP ${path} failed with ${statusCode}: ${text}`));
            return;
          }
          try {
            resolve(parseJsonObject(text, path));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

export function createManagedPythonDaemonBaseUrlResolver(
  options: ManagedPythonCoreDaemonOptions,
): () => Promise<string> {
  let cachedBaseUrl: string | undefined;

  return async () => {
    if (cachedBaseUrl) {
      return cachedBaseUrl;
    }

    const ensureRuntime = options.ensureRuntime ?? ensureManagedPythonCommandRuntime;
    const startDaemon = options.startDaemon ?? startManagedPythonDaemon;
    await ensureRuntime({
      cliVersion: options.cliVersion,
      installPolicy: options.installPolicy,
      io: options.io,
      feature: 'core',
    });
    const daemon = await startDaemon({
      cliVersion: options.cliVersion,
      features: ['core'],
      force: false,
    });
    const verb = daemon.status === 'started' ? 'Started' : 'Using existing';
    options.io.stderr.write(`${verb} KTX Python daemon: ${daemon.baseUrl}\n`);
    cachedBaseUrl = daemon.baseUrl;
    return cachedBaseUrl;
  };
}

function isRequestJsonOnly(options: ManagedPythonDaemonHttpOptions): options is { requestJson: ManagedPythonHttpJsonRunner } {
  return 'requestJson' in options;
}

function isResolveBaseUrlOnly(
  options: ManagedPythonDaemonHttpOptions,
): options is { resolveBaseUrl: () => Promise<string>; postJson?: ManagedPythonHttpPostJson } {
  return 'resolveBaseUrl' in options;
}

export function createManagedDaemonHttpJsonRunner(
  options: ManagedPythonDaemonHttpOptions,
): ManagedPythonHttpJsonRunner {
  if (isRequestJsonOnly(options)) {
    return options.requestJson;
  }
  const resolveBaseUrl = isResolveBaseUrlOnly(options)
    ? options.resolveBaseUrl
    : createManagedPythonDaemonBaseUrlResolver(options);
  const postJson = options.postJson ?? postManagedDaemonJson;

  return async (path, payload) => postJson(await resolveBaseUrl(), path, payload);
}

export function createManagedDaemonLookerTableIdentifierParser(
  options: ManagedPythonDaemonHttpOptions,
): LookerTableIdentifierParser {
  return createDaemonLookerTableIdentifierParser({
    baseUrl: 'http://127.0.0.1:0',
    requestJson: createManagedDaemonHttpJsonRunner(options) as KtxDaemonTableIdentifierHttpJsonRunner,
  });
}

export function createManagedDaemonSqlAnalysisPort(options: ManagedPythonDaemonHttpOptions): SqlAnalysisPort {
  return createHttpSqlAnalysisPort({
    baseUrl: 'http://127.0.0.1:0',
    requestJson: createManagedDaemonHttpJsonRunner(options) as KtxSqlAnalysisHttpJsonRunner,
  });
}

export function managedDaemonDatabaseIntrospectionOptions(
  options: ManagedPythonDaemonHttpOptions,
): Pick<DaemonLiveDatabaseIntrospectionOptions, 'requestJson'> {
  return {
    requestJson: createManagedDaemonHttpJsonRunner(options) as KtxDaemonDatabaseHttpJsonRunner,
  };
}
