import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  runPrimaryScanPrefetchWorker,
  startPrimaryScanPrefetch,
} from './setup-primary-scan-prefetch.js';

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function writeReadyProject(projectDir: string) {
  await writeFile(
    join(projectDir, 'ktx.yaml'),
    [
      'project: revenue',
      'setup:',
      '  database_connection_ids:',
      '    - warehouse',
      '  completed_steps:',
      '    - project',
      '    - llm',
      '    - embeddings',
      '    - databases',
      'connections:',
      '  warehouse:',
      '    driver: postgres',
      '    url: env:DATABASE_URL',
      'llm:',
      '  provider:',
      '    backend: anthropic',
      '  models:',
      '    default: claude-sonnet-4-6',
      'ingest:',
      '  embeddings:',
      '    backend: openai',
      '    model: text-embedding-3-small',
      '    dimensions: 1536',
      'scan:',
      '  enrichment:',
      '    mode: llm',
      '',
    ].join('\n'),
    'utf-8',
  );
}

describe('setup primary scan prefetch', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-primary-prefetch-'));
    await writeReadyProject(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('starts the background scan without printing a resume command', async () => {
    const io = makeIo();

    await expect(
      startPrimaryScanPrefetch(
        { projectDir: tempDir, inputMode: 'auto', yes: true, connectionIds: ['warehouse'] },
        io.io,
        {
          runIdFactory: () => 'setup-context-prefetch-test',
          now: () => new Date('2026-05-09T10:00:00.000Z'),
          spawnPrefetch: () => ({ logPath: join(tempDir, '.ktx', 'setup', 'context-build.log') }),
        },
      ),
    ).resolves.toMatchObject({ status: 'started', runId: 'setup-context-prefetch-test' });

    expect(io.stdout()).toContain('Primary source context scan started in the background (warehouse).');
    expect(io.stdout()).not.toContain('Resume:');
  });

  it('does not crash on progress state write failures', async () => {
    const io = makeIo();
    const setupPath = join(tempDir, '.ktx', 'setup');
    const runContextBuild = vi.fn(async (_project, _args, _io, hooks) => {
      await rm(setupPath, { recursive: true, force: true });
      await writeFile(setupPath, 'not a directory', 'utf-8');
      hooks.onSourceProgress?.([
        { connectionId: 'warehouse', operation: 'scan' as const, status: 'running' as const, startedAtMs: 1000 },
      ]);
      await rm(setupPath, { force: true });
      await mkdir(setupPath, { recursive: true });
      return { exitCode: 0, detached: false };
    });

    await expect(
      runPrimaryScanPrefetchWorker(
        { projectDir: tempDir, runId: 'setup-context-prefetch-write-failure', connectionIds: ['warehouse'] },
        io.io,
        {
          now: () => new Date('2026-05-09T10:00:00.000Z'),
          runContextBuild,
        },
      ),
    ).resolves.toBe(0);
  });
});
