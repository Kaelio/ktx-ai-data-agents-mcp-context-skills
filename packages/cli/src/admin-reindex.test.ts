import { createRequire } from 'node:module';
import type { ReindexSummary } from '@ktx/context/index-sync';
import { describe, expect, it, vi } from 'vitest';
import { renderReindexJson, renderReindexPlain, reindexHasErrors } from './admin-reindex.js';
import { runKtxCli } from './index.js';

const CLI_VERSION = (createRequire(import.meta.url)('@ktx/cli/package.json') as { version: string }).version;

function makeIo(options: { stdoutIsTTY?: boolean } = {}) {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        isTTY: options.stdoutIsTTY,
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

function summary(overrides: Partial<ReindexSummary> = {}): ReindexSummary {
  return {
    scopes: [
      {
        kind: 'wiki',
        label: 'global',
        scope: 'global',
        scopeId: null,
        scanned: 42,
        updated: 3,
        deleted: 1,
        embeddingsRecomputed: 3,
        embeddingsFailed: 0,
        durationMs: 412,
      },
      {
        kind: 'sl',
        label: 'warehouse',
        connectionId: 'warehouse',
        scanned: 18,
        updated: 2,
        deleted: 0,
        embeddingsRecomputed: 2,
        embeddingsFailed: 0,
        durationMs: 287,
      },
    ],
    totals: { scanned: 60, updated: 5, deleted: 1, embeddingsRecomputed: 5, embeddingsFailed: 0 },
    dbPath: '.ktx/db.sqlite',
    force: false,
    embeddingsAvailable: true,
    durationMs: 1234,
    ...overrides,
  };
}

describe('admin reindex renderers', () => {
  it('renders plain scope lines to stderr and summary to stdout', () => {
    const io = makeIo();

    renderReindexPlain(summary(), io.io);

    expect(io.stderr()).toContain('wiki/global\tscanned=42\tupdated=3\tdeleted=1\tembeddings=3\tduration_ms=412\n');
    expect(io.stderr()).toContain('sl/warehouse\tscanned=18\tupdated=2\tdeleted=0\tembeddings=2\tduration_ms=287\n');
    expect(io.stdout()).toBe('reindex\tscopes=2\tscanned=60\tupdated=5\tdeleted=1\tembeddings=5\tduration_ms=1234\n');
  });

  it('renders rebuilt labels in plain force mode', () => {
    const io = makeIo();

    renderReindexPlain(summary({ force: true }), io.io);

    expect(io.stderr()).toContain('rebuilt=3');
    expect(io.stdout()).toContain('rebuilt=5');
    expect(io.stdout()).not.toContain('updated=5');
  });

  it('renders json envelope to stdout only', () => {
    const io = makeIo();

    renderReindexJson(summary(), io.io);

    expect(JSON.parse(io.stdout())).toMatchObject({
      kind: 'reindex',
      data: { totals: { scanned: 60, updated: 5 } },
      meta: { command: 'admin reindex' },
    });
    expect(io.stderr()).toBe('');
  });

  it('detects per-scope errors', () => {
    expect(
      reindexHasErrors(
        summary({
          scopes: [{ ...summary().scopes[0]!, error: 'provider failed' }],
        }),
      ),
    ).toBe(true);
  });
});

describe('admin reindex Commander routing', () => {
  it('routes flags to the injectable reindex runner', async () => {
    const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tempDir = await mkdtemp(join(tmpdir(), 'ktx-admin-reindex-cli-'));
    const projectDir = join(tempDir, 'project');
    const io = makeIo();
    const adminReindex = vi.fn(async () => 0);

    try {
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, 'ktx.yaml'), '{}\n', 'utf-8');

      await expect(
        runKtxCli(
          ['--project-dir', projectDir, 'admin', 'reindex', '--force', '--json', '--output', 'plain'],
          io.io,
          { adminReindex },
        ),
      ).resolves.toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    expect(adminReindex).toHaveBeenCalledWith(
      {
        projectDir,
        force: true,
        json: true,
        output: 'plain',
        cliVersion: CLI_VERSION,
      },
      io.io,
    );
  });
});
