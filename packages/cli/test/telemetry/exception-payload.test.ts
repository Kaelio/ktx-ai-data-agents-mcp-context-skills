import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KtxCliIo } from '../../src/cli-runtime.js';
import { __resetTelemetryEmitterForTests } from '../../src/telemetry/emitter.js';
import {
  __resetTelemetryExceptionStateForTests,
  reportException,
} from '../../src/telemetry/exception.js';

function makeIo(): KtxCliIo {
  return {
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  };
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks);
  return req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw).toString('utf-8') : raw.toString('utf-8');
}

async function withCaptureServer<T>(run: (url: string, payloads: unknown[]) => Promise<T>): Promise<T> {
  const payloads: unknown[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'POST') {
      payloads.push(JSON.parse(await body(req)));
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('test server did not bind to a TCP port');
  }
  try {
    return await run(`http://127.0.0.1:${address.port}`, payloads);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function findExceptionEvent(payloads: unknown[]): Record<string, unknown> {
  for (const payload of payloads) {
    if (typeof payload !== 'object' || payload === null) {
      continue;
    }
    const record = payload as Record<string, unknown>;
    const batch = Array.isArray(record.batch) ? record.batch : [record];
    for (const item of batch) {
      if (typeof item === 'object' && item !== null && (item as Record<string, unknown>).event === '$exception') {
        return item as Record<string, unknown>;
      }
    }
  }
  throw new Error(`No $exception payload found: ${JSON.stringify(payloads)}`);
}

describe('prepared Node exception payload', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ktx-node-exception-payload-'));
    await mkdir(join(homeDir, '.ktx'), { recursive: true });
    await writeFile(
      join(homeDir, '.ktx', 'telemetry.json'),
      `${JSON.stringify({
        installId: '00000000-0000-4000-8000-000000000000',
        enabled: true,
        createdAt: '2026-06-05T00:00:00.000Z',
      })}\n`,
      'utf-8',
    );
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('CI', '');
    vi.stubEnv('KTX_TELEMETRY_DISABLED', '');
    vi.stubEnv('DO_NOT_TRACK', '');
    __resetTelemetryEmitterForTests();
    __resetTelemetryExceptionStateForTests();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(homeDir, { recursive: true, force: true });
  });

  it('sends projectId, omits $groups, and redacts the serialized exception list', async () => {
    await withCaptureServer(async (endpoint, payloads) => {
      vi.stubEnv('KTX_TELEMETRY_ENDPOINT', endpoint);
      const projectDir = join(homeDir, 'project');
      const snapshotSecret = ['plain', 'secret', 'value'].join('-');
      const dbPassword = ['db', 'url', 'secret'].join('-');
      const authToken = ['abc', '123'].join('');
      const error = new Error(
        `${snapshotSecret} postgres://svc:${dbPassword}@db.example.test/analytics Authorization: Basic ${authToken}`,
      );

      await reportException({
        error,
        context: { source: 'scan run', handled: true, fatal: false },
        io: makeIo(),
        packageInfo: { name: '@kaelio/ktx', version: '0.0.0-test' },
        projectDir,
        immediate: true,
        redactionSecrets: [snapshotSecret],
      });

      const event = findExceptionEvent(payloads);
      const properties = event.properties as Record<string, unknown>;
      expect(properties.projectId).toMatch(/^[a-f0-9]{64}$/);
      expect(properties.$groups).toBeUndefined();
      expect(JSON.stringify(properties.$exception_list)).toContain('[redacted]');
      expect(JSON.stringify(properties.$exception_list)).not.toContain(snapshotSecret);
      expect(JSON.stringify(properties.$exception_list)).not.toContain(dbPassword);
      expect(JSON.stringify(properties.$exception_list)).not.toContain(authToken);
      for (const key of [
        'argv',
        'args',
        'env',
        'environment',
        'sql',
        'query',
        'prompt',
        'mcpArguments',
        'tableName',
        'schemaName',
        'columnName',
        'databaseUrl',
        'connectionString',
        'url',
        'password',
        'token',
        'apiKey',
        'authorization',
      ]) {
        expect(properties).not.toHaveProperty(key);
      }
    });
  });
});
