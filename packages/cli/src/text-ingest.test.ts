import { describe, expect, it, vi } from 'vitest';
import type { MemoryCaptureStatus } from '@ktx/context/memory';
import type { KtxLocalProject } from '@ktx/context/project';
import { runKtxTextIngest, type TextMemoryCapturePort } from './text-ingest.js';

function makeIo(options: { isTTY?: boolean } = {}) {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        isTTY: options.isTTY,
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

function fakeCapture(
  options: {
    failRunIds?: Set<string>;
    missingStatusRunIds?: Set<string>;
    events?: string[];
  } = {},
): TextMemoryCapturePort {
  let next = 1;
  return {
    capture: vi.fn(async () => {
      const runId = `run-${next++}`;
      options.events?.push(`capture:${runId}`);
      return { runId };
    }),
    waitForRun: vi.fn(async (runId: string) => {
      options.events?.push(`wait:${runId}`);
    }),
    status: vi.fn(async (runId: string) => {
      options.events?.push(`status:${runId}`);
      if (options.missingStatusRunIds?.has(runId)) {
        return null;
      }
      if (options.failRunIds?.has(runId)) {
        return {
          runId,
          status: 'error',
          stage: 'capturing',
          done: true,
          captured: { wiki: [], sl: [], xrefs: [] },
          error: `${runId} failed`,
          commitHash: null,
          skillsLoaded: [],
          signalDetected: false,
        } satisfies MemoryCaptureStatus;
      }
      return {
        runId,
        status: 'done',
        stage: 'capturing',
        done: true,
        captured: { wiki: [`wiki-${runId}`], sl: [`sl-${runId}`], xrefs: [] },
        error: null,
        commitHash: `commit-${runId}`,
        skillsLoaded: ['wiki_capture', 'sl'],
        signalDetected: true,
      } satisfies MemoryCaptureStatus;
    }),
  };
}

function fakeProject(projectDir = '/tmp/project'): KtxLocalProject {
  return { projectDir } as KtxLocalProject;
}

describe('runKtxTextIngest', () => {
  it('captures repeated inline text sequentially with generated internal chat ids', async () => {
    const io = makeIo();
    const events: string[] = [];
    const capture = fakeCapture({ events });
    const createMemoryCapture = vi.fn(() => capture);

    await expect(
      runKtxTextIngest(
        {
          projectDir: '/tmp/project',
          texts: ['Revenue means gross receipts.', 'Orders are completed purchases.'],
          files: [],
          userId: 'local-cli',
          json: true,
          failFast: false,
        },
        io.io,
        {
          loadProject: vi.fn(async () => fakeProject()),
          createMemoryCapture,
          now: () => 1_700_000_000_000,
        },
      ),
    ).resolves.toBe(0);

    expect(createMemoryCapture).toHaveBeenCalledWith({ projectDir: '/tmp/project' });
    expect(capture.capture).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        userId: 'local-cli',
        chatId: 'cli-text-ingest-1700000000000-1',
        userMessage: 'Ingest external text artifact "Revenue means gross receipts." into KTX memory.',
        assistantMessage: 'Revenue means gross receipts.',
        sourceType: 'external_ingest',
      }),
    );
    expect(capture.capture).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chatId: 'cli-text-ingest-1700000000000-2',
        userMessage: 'Ingest external text artifact "Orders are completed purchases." into KTX memory.',
        assistantMessage: 'Orders are completed purchases.',
      }),
    );
    expect(capture.capture).not.toHaveBeenCalledWith(expect.objectContaining({ connectionId: expect.anything() }));
    expect(events).toEqual(['capture:run-1', 'wait:run-1', 'status:run-1', 'capture:run-2', 'wait:run-2', 'status:run-2']);
    expect(JSON.parse(io.stdout())).toMatchObject({
      status: 'done',
      results: [
        {
          label: '"Revenue means gross receipts."',
          runId: 'run-1',
          status: 'done',
          captured: { wiki: ['wiki-run-1'], sl: ['sl-run-1'] },
        },
        {
          label: '"Orders are completed purchases."',
          runId: 'run-2',
          status: 'done',
          captured: { wiki: ['wiki-run-2'], sl: ['sl-run-2'] },
        },
      ],
    });
  });

  it('loads files and stdin as batch items and passes a global connection id', async () => {
    const io = makeIo();
    const capture = fakeCapture();

    await expect(
      runKtxTextIngest(
        {
          projectDir: '/tmp/project',
          texts: [],
          files: ['/tmp/docs/revenue.md', '-'],
          connectionId: 'warehouse',
          userId: 'agent',
          json: false,
          failFast: false,
        },
        io.io,
        {
          loadProject: vi.fn(async () => fakeProject()),
          createMemoryCapture: vi.fn(() => capture),
          readFile: vi.fn(async (path) => `file:${path}`),
          readStdin: vi.fn(async () => 'stdin content'),
          now: () => 10,
        },
      ),
    ).resolves.toBe(0);

    expect(capture.capture).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        connectionId: 'warehouse',
        userId: 'agent',
        userMessage: 'Ingest external text artifact "revenue.md" into KTX memory.',
        assistantMessage: 'file:/tmp/docs/revenue.md',
      }),
    );
    expect(capture.capture).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        connectionId: 'warehouse',
        userMessage: 'Ingest external text artifact "stdin" into KTX memory.',
        assistantMessage: 'stdin content',
      }),
    );
    expect(io.stdout()).toContain('Ingesting text memory');
    expect(io.stdout()).toContain('Texts:');
    expect(io.stdout()).toContain('revenue.md');
    expect(io.stdout()).toContain('stdin');
  });

  it('uses bounded inline text previews as labels in plain output and capture metadata', async () => {
    const io = makeIo();
    const capture = fakeCapture();
    const longText = `This inline note is intentionally long ${'x'.repeat(120)}`;

    await expect(
      runKtxTextIngest(
        {
          projectDir: '/tmp/project',
          texts: ['remember to call me Andrey', '  first line\n\tsecond line  ', longText],
          files: [],
          userId: 'local-cli',
          json: false,
          failFast: false,
        },
        io.io,
        {
          loadProject: vi.fn(async () => fakeProject()),
          createMemoryCapture: vi.fn(() => capture),
          now: () => 10,
        },
      ),
    ).resolves.toBe(0);

    const output = io.stdout();
    expect(output).toContain('"remember to call me Andrey"');
    expect(output).toContain('"first line second line"');
    expect(output).toContain('"This inline note is intentionally long xxxxxxxx..."');
    expect(output).not.toContain('text-1');
    expect(output).not.toContain(longText);

    expect(capture.capture).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        userMessage: 'Ingest external text artifact "remember to call me Andrey" into KTX memory.',
      }),
    );
    expect(capture.capture).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        userMessage: 'Ingest external text artifact "first line second line" into KTX memory.',
      }),
    );
    expect(capture.capture).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        userMessage: 'Ingest external text artifact "This inline note is intentionally long xxxxxxxx..." into KTX memory.',
      }),
    );
  });

  it('continues after an item failure by default and stops when failFast is set', async () => {
    const continueIo = makeIo();
    const continueCapture = fakeCapture({ failRunIds: new Set(['run-1']) });

    await expect(
      runKtxTextIngest(
        {
          projectDir: '/tmp/project',
          texts: ['bad', 'good'],
          files: [],
          userId: 'local-cli',
          json: true,
          failFast: false,
        },
        continueIo.io,
        {
          loadProject: vi.fn(async () => fakeProject()),
          createMemoryCapture: vi.fn(() => continueCapture),
        },
      ),
    ).resolves.toBe(1);

    expect(continueCapture.capture).toHaveBeenCalledTimes(2);
    expect(JSON.parse(continueIo.stdout())).toMatchObject({
      status: 'failed',
      results: [
        { label: '"bad"', status: 'error', error: 'run-1 failed' },
        { label: '"good"', status: 'done' },
      ],
    });

    const failFastIo = makeIo();
    const failFastCapture = fakeCapture({ failRunIds: new Set(['run-1']) });

    await expect(
      runKtxTextIngest(
        {
          projectDir: '/tmp/project',
          texts: ['bad', 'skipped'],
          files: [],
          userId: 'local-cli',
          json: true,
          failFast: true,
        },
        failFastIo.io,
        {
          loadProject: vi.fn(async () => fakeProject()),
          createMemoryCapture: vi.fn(() => failFastCapture),
        },
      ),
    ).resolves.toBe(1);

    expect(failFastCapture.capture).toHaveBeenCalledTimes(1);
    expect(JSON.parse(failFastIo.stdout()).results).toHaveLength(1);
  });

  it('rejects empty batches and empty text items', async () => {
    const noInputIo = makeIo();
    await expect(
      runKtxTextIngest(
        {
          projectDir: '/tmp/project',
          texts: [],
          files: [],
          userId: 'local-cli',
          json: false,
          failFast: false,
        },
        noInputIo.io,
        { loadProject: vi.fn(), createMemoryCapture: vi.fn() },
      ),
    ).resolves.toBe(1);
    expect(noInputIo.stderr()).toContain('Provide at least one text item');

    const emptyIo = makeIo();
    await expect(
      runKtxTextIngest(
        {
          projectDir: '/tmp/project',
          texts: ['   '],
          files: [],
          userId: 'local-cli',
          json: false,
          failFast: false,
        },
        emptyIo.io,
        { loadProject: vi.fn(), createMemoryCapture: vi.fn() },
      ),
    ).resolves.toBe(1);
    expect(emptyIo.stderr()).toContain('Text item "text-1" is empty');
  });
});
