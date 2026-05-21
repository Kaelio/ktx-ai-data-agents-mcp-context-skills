import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LocalIngestResult, RunLocalIngestOptions } from './context/ingest/local-ingest.js';
import type { MemoryFlowReplayInput } from './context/ingest/memory-flow/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runKtxIngest } from './ingest.js';
import {
  completedLocalBundleRun,
  emitLiveLocalMemoryFlow,
  localFakeBundleReport,
  makeIo,
  persistLocalBundleReport,
  writeBundleReportFile,
  writeWarehouseConfig,
} from './ingest.test-utils.js';
import { resetVizFallbackWarningsForTest } from './viz-fallback.js';

describe('runKtxIngest viz and replay', () => {
  let tempDir: string;
  let originalTerm: string | undefined;
  const interactiveEnv = (): NodeJS.ProcessEnv => ({ ...process.env, CI: 'false' });

  beforeEach(async () => {
    resetVizFallbackWarningsForTest();
    originalTerm = process.env.TERM;
    process.env.TERM = 'xterm-256color';
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-cli-ingest-'));
  });

  afterEach(async () => {
    if (originalTerm === undefined) {
      delete process.env.TERM;
    } else {
      process.env.TERM = originalTerm;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('renders live memory-flow frames for run --viz when stdout is interactive', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    const runLocal = vi.fn(async (input: RunLocalIngestOptions): Promise<LocalIngestResult> => {
      input.memoryFlow?.emit({ type: 'source_acquired', adapter: 'fake', trigger: 'manual_resync', fileCount: 1 });
      input.memoryFlow?.update({ syncId: 'sync-live-1' });
      input.memoryFlow?.emit({ type: 'raw_snapshot_written', syncId: 'sync-live-1', rawFileCount: 1 });
      input.memoryFlow?.emit({ type: 'diff_computed', added: 1, modified: 0, deleted: 0, unchanged: 0 });
      input.memoryFlow?.update({
        plannedWorkUnits: [
          {
            unitKey: 'fake-orders',
            rawFiles: ['orders/orders.json'],
            peerFileCount: 0,
            dependencyCount: 0,
          },
        ],
      });
      input.memoryFlow?.emit({ type: 'chunks_planned', chunkCount: 1, workUnitCount: 1, evictionCount: 0 });
      input.memoryFlow?.emit({ type: 'report_created', runId: 'live-viz-run' });
      input.memoryFlow?.finish('done');

      return completedLocalBundleRun(input, 'live-viz-run');
    });
    const io = makeIo({ isTTY: true, stdinIsTTY: true, columns: 120 });
    const startLiveMemoryFlow = vi.fn(async (_input: MemoryFlowReplayInput, _io: unknown) => null);

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          sourceDir,
          outputMode: 'viz',
        },
        io.io,
        {
          runLocalIngest: runLocal,
          startLiveMemoryFlow,
          jobIdFactory: () => 'live-viz-run',
          now: () => new Date('2026-04-30T14:00:00.000Z'),
        },
      ),
    ).resolves.toBe(0);

    expect(runLocal).toHaveBeenCalledWith(expect.objectContaining({ memoryFlow: expect.any(Object) }));
    expect(io.stdout()).toContain('\u001b[2J\u001b[H');
    expect((io.stdout().match(/KTX memory flow/g) ?? []).length).toBeGreaterThan(1);
    expect(io.stdout()).toContain('KTX memory flow  warehouse/fake  done');
    expect(io.stdout()).toContain('fake-orders');
    expect(io.stderr()).toBe('');
  });

  it('uses the TUI live session for run --viz when stdin and stdout are interactive', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    const runLocal = vi.fn(async (input: RunLocalIngestOptions): Promise<LocalIngestResult> => {
      emitLiveLocalMemoryFlow(input.memoryFlow);
      return completedLocalBundleRun(input, 'live-viz-run');
    });
    const liveSession = {
      update: vi.fn(),
      close: vi.fn(),
      isClosed: vi.fn(() => false),
    };
    const startLiveMemoryFlow = vi.fn(async (_input: MemoryFlowReplayInput, _io: unknown) => liveSession);
    const io = makeIo({ isTTY: true, stdinIsTTY: true, columns: 120 });

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          sourceDir,
          outputMode: 'viz',
        },
        io.io,
        {
          runLocalIngest: runLocal,
          startLiveMemoryFlow,
          jobIdFactory: () => 'live-viz-run',
          now: () => new Date('2026-04-30T14:00:00.000Z'),
        },
      ),
    ).resolves.toBe(0);

    expect(startLiveMemoryFlow).toHaveBeenCalledTimes(1);
    expect(startLiveMemoryFlow.mock.calls[0]?.[0]).toMatchObject({
      runId: 'live-viz-run',
      connectionId: 'warehouse',
      adapter: 'fake',
      status: 'running',
    });
    expect(liveSession.update).toHaveBeenCalled();
    expect(liveSession.close).toHaveBeenCalledTimes(1);
    expect(io.stdout()).not.toContain('\u001b[2J\u001b[H');
    expect(io.stdout()).not.toContain('KTX memory flow');
    expect(io.stderr()).toBe('');
  });

  it('prints a final plain summary after live viz completes', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const io = makeIo({ isTTY: true, stdinIsTTY: true, columns: 120 });
    const liveSession = {
      update: vi.fn(),
      close: vi.fn(),
      isClosed: vi.fn(() => false),
    };
    const startLiveMemoryFlow = vi.fn(async (_input: MemoryFlowReplayInput, _io: unknown) => liveSession);
    const runLocal = vi.fn(async (input: RunLocalIngestOptions) => {
      emitLiveLocalMemoryFlow(input.memoryFlow);
      return completedLocalBundleRun(input, 'live-summary');
    });

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          outputMode: 'viz',
        },
        io.io,
        { runLocalIngest: runLocal, startLiveMemoryFlow },
      ),
    ).resolves.toBe(0);

    expect(liveSession.close).toHaveBeenCalledTimes(1);
    expect(io.stdout()).toContain('Memory-flow summary: done');
    expect(io.stdout()).toContain('Connection: warehouse');
  });

  it('prints live viz final summaries as errors when the report has failed work units', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const io = makeIo({ isTTY: true, stdinIsTTY: true, columns: 120 });
    const liveSession = {
      update: vi.fn(),
      close: vi.fn(),
      isClosed: vi.fn(() => false),
    };
    const startLiveMemoryFlow = vi.fn(async (_input: MemoryFlowReplayInput, _io: unknown) => liveSession);
    const runLocal = vi.fn(async (input: RunLocalIngestOptions): Promise<LocalIngestResult> => {
      input.memoryFlow?.emit({ type: 'source_acquired', adapter: 'notion', trigger: 'manual_resync', fileCount: 37 });
      input.memoryFlow?.update({
        syncId: 'sync-notion',
        plannedWorkUnits: [
          {
            unitKey: 'notion-cluster-1',
            rawFiles: ['pages/a.md'],
            peerFileCount: 0,
            dependencyCount: 0,
          },
        ],
      });
      input.memoryFlow?.emit({ type: 'chunks_planned', chunkCount: 1, workUnitCount: 1, evictionCount: 0 });
      input.memoryFlow?.emit({
        type: 'work_unit_finished',
        unitKey: 'notion-cluster-1',
        status: 'failed',
        reason: 'notion-cluster-1 failed: {"error":"invalid_grant","error_description":"reauth related error (invalid_rapt)"}',
      });
      input.memoryFlow?.emit({ type: 'report_created', runId: 'live-failed' });
      input.memoryFlow?.finish('done');

      const failedWorkUnit = {
        ...localFakeBundleReport('live-failed').body.workUnits[0],
        unitKey: 'notion-cluster-1',
        rawFiles: ['pages/a.md'],
        status: 'failed' as const,
        reason: 'notion-cluster-1 failed: {"error":"invalid_grant","error_description":"reauth related error (invalid_rapt)"}',
        actions: [],
        touchedSlSources: [],
      };
      const report = localFakeBundleReport('live-failed', {
        id: 'report-live-failed',
        runId: 'run-live-failed',
        connectionId: input.connectionId,
        sourceKey: input.adapter,
        body: {
          workUnits: [failedWorkUnit],
          failedWorkUnits: [failedWorkUnit.unitKey],
        },
      });
      return {
        result: {
          jobId: 'live-failed',
          runId: report.runId,
          syncId: report.body.syncId,
          diffSummary: report.body.diffSummary,
          workUnitCount: report.body.workUnits.length,
          failedWorkUnits: report.body.failedWorkUnits,
          artifactsWritten: report.body.provenanceRows.length,
          commitSha: report.body.commitSha,
        },
        report,
      };
    });

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'notion-main',
          adapter: 'notion',
          outputMode: 'viz',
        },
        io.io,
        { runLocalIngest: runLocal, startLiveMemoryFlow },
      ),
    ).resolves.toBe(1);

    expect(io.stdout()).toContain('Memory-flow summary: error');
    expect(io.stdout()).toContain('Notion authorization expired');
  });

  it('falls back to text live rendering when the TUI live session is unavailable', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    const runLocal = vi.fn(async (input: RunLocalIngestOptions): Promise<LocalIngestResult> => {
      emitLiveLocalMemoryFlow(input.memoryFlow);
      return completedLocalBundleRun(input, 'live-viz-run');
    });
    const startLiveMemoryFlow = vi.fn(async (_input: MemoryFlowReplayInput, _io: unknown) => null);
    const io = makeIo({ isTTY: true, stdinIsTTY: true, columns: 120 });

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          sourceDir,
          outputMode: 'viz',
        },
        io.io,
        {
          runLocalIngest: runLocal,
          startLiveMemoryFlow,
          jobIdFactory: () => 'live-viz-run',
        },
      ),
    ).resolves.toBe(0);

    expect(startLiveMemoryFlow).toHaveBeenCalledTimes(1);
    expect(io.stdout()).toContain('\u001b[2J\u001b[H');
    expect(io.stdout()).toContain('KTX memory flow  warehouse/fake  done');
  });

  it('falls back to text live rendering when TUI startup fails with a redacted warning', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    const runLocal = vi.fn(async (input: RunLocalIngestOptions): Promise<LocalIngestResult> => {
      emitLiveLocalMemoryFlow(input.memoryFlow);
      return completedLocalBundleRun(input, 'live-viz-run');
    });
    const startLiveMemoryFlow = vi.fn(
      async (_input: MemoryFlowReplayInput, ioArg: { stderr: { write(chunk: string): void } }) => {
        ioArg.stderr.write('TUI visualization unavailable: Failed [redacted-url] [redacted]; using text renderer.\n');
        return null;
      },
    );
    const io = makeIo({ isTTY: true, stdinIsTTY: true, columns: 120 });

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          sourceDir,
          outputMode: 'viz',
        },
        io.io,
        {
          runLocalIngest: runLocal,
          startLiveMemoryFlow,
          jobIdFactory: () => 'live-viz-run',
        },
      ),
    ).resolves.toBe(0);

    expect(io.stderr()).toContain('TUI visualization unavailable: Failed [redacted-url] [redacted]');
    expect(io.stdout()).toContain('KTX memory flow  warehouse/fake  done');
    expect(io.stdout()).toContain('\u001b[2J\u001b[H');
  });

  it('does not start live TUI when run --viz disables input', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    const runLocal = vi.fn(async (input: RunLocalIngestOptions): Promise<LocalIngestResult> => {
      return completedLocalBundleRun(input, 'no-input-live-viz-run');
    });
    const startLiveMemoryFlow = vi.fn(async (_input: MemoryFlowReplayInput, _io: unknown) => ({
      update: vi.fn(),
      close: vi.fn(),
      isClosed: vi.fn(() => false),
    }));
    const io = makeIo({ isTTY: true, stdinIsTTY: true, columns: 120 });

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          sourceDir,
          outputMode: 'viz',
          inputMode: 'disabled',
        },
        io.io,
        { runLocalIngest: runLocal, startLiveMemoryFlow },
      ),
    ).resolves.toBe(0);

    expect(startLiveMemoryFlow).not.toHaveBeenCalled();
    expect(runLocal).toHaveBeenCalledWith(expect.not.objectContaining({ memoryFlow: expect.anything() }));
    expect(io.stdout()).toContain('KTX memory flow  warehouse/fake  done');
  });

  it('attaches a plain progress memory-flow sink for interactive plain run output', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    const runLocal = vi.fn(async (input: RunLocalIngestOptions) => completedLocalBundleRun(input, 'plain-run'));
    const io = makeIo({ isTTY: true });

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          sourceDir,
          outputMode: 'plain',
        },
        io.io,
        { env: interactiveEnv(), runLocalIngest: runLocal },
      ),
    ).resolves.toBe(0);

    expect(runLocal).toHaveBeenCalledWith(expect.objectContaining({ memoryFlow: expect.anything() }));
    expect(io.stderr()).toContain('[5%] Fetching source files for warehouse/fake');
    expect(io.stdout()).toContain('Job: plain-run');
    expect(io.stdout()).not.toContain('[5%]');
    expect(io.stdout()).not.toContain('KTX memory flow');
  });

  it('falls back to plain run output for run --viz when stdout is not interactive', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    const io = makeIo({ isTTY: false });
    const runLocal = vi.fn(async (input: RunLocalIngestOptions) => completedLocalBundleRun(input, 'non-tty-viz-run'));
    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          sourceDir,
          outputMode: 'viz',
        },
        io.io,
        {
          runLocalIngest: runLocal,
          jobIdFactory: () => 'non-tty-viz-run',
        },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Job: non-tty-viz-run');
    expect(io.stdout()).not.toContain('KTX memory flow');
    expect(io.stderr()).toContain(
      'Visualization requested but stdout is not an interactive terminal; printing plain output.',
    );
  });

  it('falls back to plain run output for run --viz when stdin raw mode is unavailable', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    const io = makeIo({ isTTY: true, stdinIsTTY: true, rawMode: false, columns: 120 });
    const runLocal = vi.fn(async (input: RunLocalIngestOptions) => completedLocalBundleRun(input, 'raw-missing-viz-run'));
    const startLiveMemoryFlow = vi.fn(async (_input: MemoryFlowReplayInput, _io: unknown) => ({
      update: vi.fn(),
      close: vi.fn(),
      isClosed: vi.fn(() => false),
    }));

    await expect(
      runKtxIngest(
        {
          command: 'run',
          projectDir,
          connectionId: 'warehouse',
          adapter: 'fake',
          sourceDir,
          outputMode: 'viz',
        },
        io.io,
        {
          env: interactiveEnv(),
          runLocalIngest: runLocal,
          startLiveMemoryFlow,
          jobIdFactory: () => 'raw-missing-viz-run',
        },
      ),
    ).resolves.toBe(0);

    expect(startLiveMemoryFlow).not.toHaveBeenCalled();
    expect(runLocal).toHaveBeenCalledWith(expect.objectContaining({ memoryFlow: expect.anything() }));
    expect(io.stderr()).toContain('[5%] Fetching source files for warehouse/fake');
    expect(io.stdout()).toContain('Job: raw-missing-viz-run');
    expect(io.stdout()).not.toContain('[5%]');
    expect(io.stdout()).not.toContain('KTX memory flow');
    expect(io.stderr()).toContain(
      'Visualization requested but stdin raw mode is unavailable; printing plain output.',
    );
  });

  it('returns an error code for missing status', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const io = makeIo();

    await expect(
      runKtxIngest({ command: 'status', projectDir, runId: 'missing-run', outputMode: 'plain' }, io.io),
    ).resolves.toBe(1);

    expect(io.stderr()).toContain('Local ingest run or report "missing-run" was not found');
  });

  it('suggests public ingest when status has no stored reports', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const io = makeIo();

    await expect(runKtxIngest({ command: 'status', projectDir, outputMode: 'plain' }, io.io)).resolves.toBe(1);

    expect(io.stderr()).toContain('No local ingest reports were found. Run `ktx ingest <connectionId>` first.');
    expect(io.stderr()).not.toContain('ktx ingest run --connection-id');
    expect(io.stderr()).not.toContain('--adapter');
  });

  it('uses the latest local ingest report when status has no run id', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    await persistLocalBundleReport(projectDir, localFakeBundleReport('older-run'));
    await persistLocalBundleReport(projectDir, localFakeBundleReport('newer-run'));
    const io = makeIo();

    await expect(runKtxIngest({ command: 'status', projectDir, outputMode: 'plain' }, io.io)).resolves.toBe(0);

    expect(io.stdout()).toContain('Run: run-newer-run');
    expect(io.stdout()).toContain('Job: newer-run');
    expect(io.stderr()).toBe('');
  });

  it('renders the latest local ingest report through watch when run id is omitted', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    await persistLocalBundleReport(projectDir, localFakeBundleReport('watch-latest'));
    const io = makeIo({ isTTY: true });

    await expect(
      runKtxIngest({ command: 'watch', projectDir, outputMode: 'viz', inputMode: 'disabled' }, io.io),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('KTX memory flow  warehouse/fake  done');
    expect(io.stdout()).toContain('Run: run-watch-latest');
    expect(io.stderr()).toBe('');
  });

  it('renders report-file replay through the memory-flow TUI', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const reportFile = await writeBundleReportFile(tempDir);
    const io = makeIo({ isTTY: true });

    await expect(
      runKtxIngest(
        {
          command: 'replay',
          projectDir,
          runId: 'job-1',
          reportFile,
          outputMode: 'viz',
          inputMode: 'disabled',
        },
        io.io,
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('KTX memory flow  warehouse/metabase  done');
    expect(io.stdout()).toContain('Saved 2 memories from 2 raw files');
    expect(io.stdout()).toContain('Commit: abc12345  Run: run-1  Report: report-1');
    expect(io.stdout()).toContain('SOURCE');
    expect(io.stdout()).toContain('ACTIONS');
    expect(io.stdout()).toContain('SAVED');
    expect(io.stderr()).toBe('');
  });

  it('prints report-file JSON without looking up local ingest status', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const reportFile = await writeBundleReportFile(tempDir);
    const io = makeIo();

    await expect(
      runKtxIngest({ command: 'status', projectDir, runId: 'report-1', reportFile, outputMode: 'json' }, io.io),
    ).resolves.toBe(0);

    const parsed = JSON.parse(io.stdout());
    expect(parsed).toMatchObject({
      id: 'report-1',
      runId: 'run-1',
      jobId: 'job-1',
      connectionId: 'warehouse',
      sourceKey: 'metabase',
    });
    expect(io.stderr()).toBe('');
  });

  it('routes interactive report-file replay through the stored TUI renderer', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const reportFile = await writeBundleReportFile(tempDir);
    const io = makeIo({ isTTY: true, stdinIsTTY: true, columns: 120 });
    const renderStoredMemoryFlow = vi.fn(async (_input: MemoryFlowReplayInput, _io: unknown) => true);

    await expect(
      runKtxIngest(
        {
          command: 'replay',
          projectDir,
          runId: 'run-1',
          reportFile,
          outputMode: 'viz',
        },
        io.io,
        { renderStoredMemoryFlow },
      ),
    ).resolves.toBe(0);

    expect(renderStoredMemoryFlow).toHaveBeenCalledTimes(1);
    expect(renderStoredMemoryFlow.mock.calls[0]?.[0]).toMatchObject({
      runId: 'run-1',
      reportId: 'report-1',
      connectionId: 'warehouse',
      adapter: 'metabase',
    });
    expect(io.stdout()).toBe('');
    expect(io.stderr()).toBe('');
  });

  it('rejects report-file replay when the requested id does not match the report', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const reportFile = await writeBundleReportFile(tempDir);
    const io = makeIo();

    await expect(
      runKtxIngest({ command: 'replay', projectDir, runId: 'unrelated-id', reportFile, outputMode: 'plain' }, io.io),
    ).resolves.toBe(1);

    expect(io.stderr()).toContain(
      `Report file ${reportFile} does not match ingest replay id "unrelated-id"; expected one of report-1, run-1, job-1`,
    );
    expect(io.stdout()).toBe('');
  });

  it('renders memory-flow snapshot for status --viz when stdout is interactive', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    await persistLocalBundleReport(projectDir, localFakeBundleReport('viz-run-1'));

    const io = makeIo({ isTTY: true });
    await expect(
      runKtxIngest(
        { command: 'status', projectDir, runId: 'viz-run-1', outputMode: 'viz', inputMode: 'disabled' },
        io.io,
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('KTX memory flow  warehouse/fake  done');
    expect(io.stdout()).toContain('SOURCE');
    expect(io.stdout()).toContain('CHUNKS');
    expect(io.stdout()).toContain('WORKUNITS');
    expect(io.stdout()).toContain('Saved 2 memories from 2 raw files');
    expect(io.stderr()).toBe('');
  });

  it('uses the TUI renderer for stored status --viz when stdin and stdout are interactive', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    await persistLocalBundleReport(projectDir, localFakeBundleReport('tui-viz-run'));

    const io = makeIo({ isTTY: true, stdinIsTTY: true, columns: 120 });
    const renderStoredMemoryFlow = vi.fn(async (_input: MemoryFlowReplayInput, _io: unknown) => true);

    await expect(
      runKtxIngest(
        {
          command: 'status',
          projectDir,
          runId: 'tui-viz-run',
          outputMode: 'viz',
        },
        io.io,
        { renderStoredMemoryFlow },
      ),
    ).resolves.toBe(0);

    expect(renderStoredMemoryFlow).toHaveBeenCalledTimes(1);
    expect(renderStoredMemoryFlow.mock.calls[0]?.[0]).toMatchObject({
      runId: 'run-tui-viz-run',
      connectionId: 'warehouse',
      adapter: 'fake',
    });
    expect(io.stdout()).toBe('');
    expect(io.stderr()).toBe('');
  });

  it('falls back to the text renderer when TUI declines stored status --viz', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    await persistLocalBundleReport(projectDir, localFakeBundleReport('tui-fallback-run'));

    const io = makeIo({ isTTY: true, stdinIsTTY: true, columns: 120, keypresses: [{ name: 'q' }] });
    const renderStoredMemoryFlow = vi.fn(async (_input: MemoryFlowReplayInput, _io: unknown) => false);

    await expect(
      runKtxIngest(
        {
          command: 'status',
          projectDir,
          runId: 'tui-fallback-run',
          outputMode: 'viz',
        },
        io.io,
        { renderStoredMemoryFlow },
      ),
    ).resolves.toBe(0);

    expect(renderStoredMemoryFlow).toHaveBeenCalledTimes(1);
    expect(io.stdout()).toContain('KTX memory flow  warehouse/fake  done');
  });

  it('does not use TUI for stored --viz when input is disabled', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    await persistLocalBundleReport(projectDir, localFakeBundleReport('tui-no-input-run'));

    const io = makeIo({ isTTY: true, stdinIsTTY: true, columns: 120 });
    const renderStoredMemoryFlow = vi.fn(async (_input: MemoryFlowReplayInput, _io: unknown) => true);

    await expect(
      runKtxIngest(
        {
          command: 'replay',
          projectDir,
          runId: 'tui-no-input-run',
          outputMode: 'viz',
          inputMode: 'disabled',
        },
        io.io,
        { renderStoredMemoryFlow },
      ),
    ).resolves.toBe(0);

    expect(renderStoredMemoryFlow).not.toHaveBeenCalled();
    expect(io.stdout()).toContain('KTX memory flow  warehouse/fake  done');
  });

  it('falls back to plain status for stored --viz when stdin raw mode is unavailable', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    await persistLocalBundleReport(projectDir, localFakeBundleReport('raw-missing-stored-viz-run'));

    const io = makeIo({ isTTY: true, stdinIsTTY: true, rawMode: false, columns: 120 });
    const renderStoredMemoryFlow = vi.fn(async (_input: MemoryFlowReplayInput, _io: unknown) => true);

    await expect(
      runKtxIngest(
        {
          command: 'replay',
          projectDir,
          runId: 'raw-missing-stored-viz-run',
          outputMode: 'viz',
        },
        io.io,
        { renderStoredMemoryFlow },
      ),
    ).resolves.toBe(0);

    expect(renderStoredMemoryFlow).not.toHaveBeenCalled();
    expect(io.stdout()).toContain('Run: run-raw-missing-stored-viz-run');
    expect(io.stdout()).toContain('Job: raw-missing-stored-viz-run');
    expect(io.stdout()).not.toContain('KTX memory flow');
    expect(io.stderr()).toContain(
      'Visualization requested but stdin raw mode is unavailable; printing plain output.',
    );
  });

  it('keeps stored --viz snapshot-only when input is disabled', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    await persistLocalBundleReport(projectDir, localFakeBundleReport('no-input-viz-run'));

    const io = makeIo({ isTTY: true, columns: 120 });
    await expect(
      runKtxIngest(
        {
          command: 'replay',
          projectDir,
          runId: 'no-input-viz-run',
          outputMode: 'viz',
          inputMode: 'disabled',
        },
        io.io,
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('KTX memory flow  warehouse/fake  done');
    expect(io.stdout()).not.toContain('\u001b[2J\u001b[H');
    expect(io.stderr()).toBe('');
  });

  it('keeps disabled-input stored --viz snapshot output even when stdin raw mode is unavailable', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    await persistLocalBundleReport(projectDir, localFakeBundleReport('disabled-raw-missing-viz-run'));

    const io = makeIo({ isTTY: true, stdinIsTTY: true, rawMode: false, columns: 120 });
    await expect(
      runKtxIngest(
        {
          command: 'replay',
          projectDir,
          runId: 'disabled-raw-missing-viz-run',
          outputMode: 'viz',
          inputMode: 'disabled',
        },
        io.io,
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('KTX memory flow  warehouse/fake  done');
    expect(io.stdout()).not.toContain('\u001b[2J\u001b[H');
    expect(io.stderr()).toBe('');
  });

  it('degrades stored --viz snapshots to plain status when stdout is redirected even when input is disabled', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    await persistLocalBundleReport(projectDir, localFakeBundleReport('redirected-no-input-viz-run'));

    const io = makeIo({ isTTY: false });
    await expect(
      runKtxIngest(
        {
          command: 'replay',
          projectDir,
          runId: 'redirected-no-input-viz-run',
          outputMode: 'viz',
          inputMode: 'disabled',
        },
        io.io,
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Run: run-redirected-no-input-viz-run');
    expect(io.stdout()).toContain('Job: redirected-no-input-viz-run');
    expect(io.stdout()).not.toContain('KTX memory flow');
    expect(io.stderr()).toContain(
      'Visualization requested but stdout is not an interactive terminal; printing plain output.',
    );
  });

  it('degrades ingest replay --viz to plain status when TERM is dumb', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    await persistLocalBundleReport(projectDir, localFakeBundleReport('dumb-terminal-viz-run'));

    const io = makeIo({ isTTY: true });
    await expect(
      runKtxIngest(
        { command: 'replay', projectDir, runId: 'dumb-terminal-viz-run', outputMode: 'viz' },
        io.io,
        { env: { ...process.env, TERM: 'dumb' } },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Run: run-dumb-terminal-viz-run');
    expect(io.stdout()).toContain('Job: dumb-terminal-viz-run');
    expect(io.stdout()).not.toContain('KTX memory flow');
    expect(io.stderr()).toContain(
      'Visualization requested but TERM=dumb does not support the visual renderer; printing plain output.',
    );
  });

  it('falls back to plain status for --viz when stdout is not interactive', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    await persistLocalBundleReport(projectDir, localFakeBundleReport('viz-run-2'));

    const io = makeIo({ isTTY: false });
    await expect(
      runKtxIngest({ command: 'replay', projectDir, runId: 'viz-run-2', outputMode: 'viz' }, io.io),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Run: run-viz-run-2');
    expect(io.stdout()).toContain('Job: viz-run-2');
    expect(io.stdout()).not.toContain('KTX memory flow');
    expect(io.stderr()).toContain(
      'Visualization requested but stdout is not an interactive terminal; printing plain output.',
    );
  });

  it('prints JSON for status --json', async () => {
    const projectDir = join(tempDir, 'project');
    await writeWarehouseConfig(projectDir);
    const sourceDir = join(tempDir, 'source');
    await mkdir(join(sourceDir, 'orders'), { recursive: true });
    await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');

    await persistLocalBundleReport(projectDir, localFakeBundleReport('json-run-1'));

    const io = makeIo();
    await expect(
      runKtxIngest({ command: 'status', projectDir, runId: 'json-run-1', outputMode: 'json' }, io.io),
    ).resolves.toBe(0);

    expect(JSON.parse(io.stdout())).toMatchObject({
      runId: 'run-json-run-1',
      jobId: 'json-run-1',
      sourceKey: 'fake',
      connectionId: 'warehouse',
    });
    expect(io.stderr()).toBe('');
  });
});
