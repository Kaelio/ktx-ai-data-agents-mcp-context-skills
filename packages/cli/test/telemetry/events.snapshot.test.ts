import { describe, expect, it } from 'vitest';

import { buildTelemetryEvent, type TelemetryCommonEnvelope } from '../../src/telemetry/events.js';

const BLACKLIST = [
  '/Users/',
  '/home/',
  'C:\\',
  'localhost',
  '.local',
  'kaelio.com',
  'select ',
  'SELECT ',
  'INSERT',
  'CREATE',
  '@',
  'password',
  'secret',
  'token',
  'key',
];

const envelope: TelemetryCommonEnvelope = {
  cliVersion: '0.4.1',
  nodeVersion: 'v22.0.0',
  osPlatform: 'darwin',
  osRelease: '25.0.0',
  arch: 'arm64',
  runtime: 'node',
  isCi: false,
};

describe('telemetry privacy snapshot', () => {
  it('does not emit known private substrings from phase 1 event payloads', () => {
    const events = [
      buildTelemetryEvent('install_first_run', envelope, {}),
      buildTelemetryEvent('command', envelope, {
        commandPath: ['ktx', 'sql'],
        durationMs: 10,
        outcome: 'error',
        errorClass: 'KtxProjectMissingAbortError',
        flagsPresent: {
          'project-dir': true,
          connection: true,
          c: true,
        },
        hasProject: false,
        projectGroupAttached: false,
      }),
      buildTelemetryEvent('setup_step', envelope, {
        step: 'databases',
        outcome: 'completed',
        durationMs: 42,
      }),
      buildTelemetryEvent('connection_added', envelope, {
        driver: 'postgres',
        isDemoConnection: false,
      }),
      buildTelemetryEvent('connection_test', envelope, {
        driver: 'postgres',
        isDemoConnection: false,
        outcome: 'error',
        errorClass: 'KtxConnectionTestAbortError',
        durationMs: 34,
        serverVersion: '16',
      }),
      buildTelemetryEvent('project_stack_snapshot', envelope, {
        connectors: [
          { driver: 'sqlite', isDemo: true },
          { driver: 'postgres', isDemo: false },
        ],
        connectionCount: 2,
        hasSl: true,
        hasWiki: true,
        hasMcp: true,
        hasManagedRuntime: true,
      }),
      buildTelemetryEvent('ingest_completed', envelope, {
        driver: 'postgres',
        isDemoConnection: false,
        schemaCount: 2,
        tableCount: 4,
        columnCount: 20,
        rowsBucket: '<100k',
        durationMs: 100,
        outcome: 'ok',
      }),
      buildTelemetryEvent('scan_completed', envelope, {
        driver: 'postgres',
        tableCount: 4,
        columnCount: 20,
        inferredFkCount: 2,
        declaredFkCount: 1,
        durationMs: 70,
        outcome: 'ok',
      }),
      buildTelemetryEvent('sl_validate_completed', envelope, {
        sourceCount: 1,
        modelCount: 3,
        validationErrorCount: 0,
        outcome: 'ok',
        durationMs: 15,
      }),
      buildTelemetryEvent('sl_query_completed', envelope, {
        mode: 'compile',
        referencedSourceCount: 1,
        referencedDimensionCount: 2,
        referencedMeasureCount: 1,
        durationMs: 18,
        outcome: 'ok',
      }),
      buildTelemetryEvent('sql_completed', envelope, {
        driver: 'postgres',
        isDemoConnection: false,
        queryVerb: 'select',
        referencedTableCount: 3,
        durationMs: 20,
        outcome: 'ok',
      }),
      buildTelemetryEvent('wiki_query_completed', envelope, {
        queryLength: 'select private_table from /Users/alice'.length,
        resultCount: 2,
        durationMs: 8,
        outcome: 'ok',
      }),
      buildTelemetryEvent('mcp_request_completed', envelope, {
        toolName: 'sl_query',
        outcome: 'error',
        errorClass: 'KtxProjectMissingAbortError',
        durationMs: 12,
        sampleRate: 1,
        mcpClientName: 'Claude Desktop',
        mcpClientVersion: '0.7.1',
      }),
    ];

    const payload = JSON.stringify(events);

    for (const forbidden of BLACKLIST) {
      expect(payload).not.toContain(forbidden);
    }
  });
});
