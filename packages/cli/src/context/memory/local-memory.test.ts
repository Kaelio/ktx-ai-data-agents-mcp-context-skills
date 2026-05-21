import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initKtxProject } from '../../context/project/project.js';
import { createLocalProjectMemoryIngest } from './local-memory.js';
import { LocalMemoryRunStore } from './local-memory-runs.js';

vi.mock('ai', () => ({
  generateText: vi.fn().mockResolvedValue({ text: '', toolCalls: [] }),
  stepCountIs: (stepBudget: number) => stepBudget,
  tool: (definition: unknown) => definition,
}));

async function expectPathMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toThrow();
}

describe('LocalMemoryRunStore', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-local-memory-runs-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('persists running, done, and reloadable memory run status in SQLite', async () => {
    const store = new LocalMemoryRunStore({
      projectDir: tempDir,
      idFactory: () => 'memory-run-1',
    });

    const created = await store.createRunning({ inputHash: 'hash-1', chatId: 'chat-1' });
    expect(created).toEqual({ id: 'memory-run-1' });

    await store.markRunning('memory-run-1', 'capturing');
    await store.markDone('memory-run-1', {
      signalDetected: true,
      actions: [{ target: 'wiki', type: 'created', key: 'revenue', detail: 'Revenue definition' }],
      skillsLoaded: ['wiki_capture'],
      commitHash: 'abc123',
    });

    await expect(access(join(tempDir, '.ktx/db.sqlite'))).resolves.toBeUndefined();
    await expectPathMissing(join(tempDir, '.ktx/memory-runs/memory-run-1.json'));

    await expect(store.findById('memory-run-1')).resolves.toMatchObject({
      id: 'memory-run-1',
      status: 'done',
      stage: 'done',
      inputHash: 'hash-1',
      chatId: 'chat-1',
      error: null,
      outputSummary: {
        signalDetected: true,
        commitHash: 'abc123',
      },
    });

    const reloaded = new LocalMemoryRunStore({ projectDir: tempDir });
    await expect(reloaded.findById('memory-run-1')).resolves.toMatchObject({
      id: 'memory-run-1',
      status: 'done',
      stage: 'done',
      inputHash: 'hash-1',
      chatId: 'chat-1',
      outputSummary: {
        actions: [{ target: 'wiki', type: 'created', key: 'revenue', detail: 'Revenue definition' }],
        skillsLoaded: ['wiki_capture'],
        signalDetected: true,
        commitHash: 'abc123',
      },
    });
  });
});

describe('createLocalProjectMemoryIngest', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-local-memory-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('captures a wiki page through the local memory agent and persists pollable status', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    const agentRunner = {
      runLoop: async ({
        toolSet,
      }: {
        toolSet: Record<string, { execute: (input: unknown, options?: { toolCallId?: string }) => Promise<unknown> }>;
      }) => {
        await toolSet.load_skill.execute({ name: 'wiki_capture' });
        await toolSet.wiki_write.execute(
          {
            key: 'revenue',
            summary: 'Revenue definition',
            content: 'Revenue means paid order value net of refunds.',
            tags: ['finance'],
          },
          { toolCallId: 'wiki-write' },
        );
        return { stopReason: 'natural' as const };
      },
    };

    const ingest = createLocalProjectMemoryIngest(project, {
      agentRunner: agentRunner as never,
      runIdFactory: () => 'memory-run-1',
    });

    await expect(
      ingest.ingest({
        userId: 'local-user',
        chatId: 'chat-1',
        userMessage: 'define revenue as paid order value net of refunds',
        assistantMessage: 'Captured.',
        sourceType: 'external_ingest',
      }),
    ).resolves.toEqual({ runId: 'memory-run-1' });
    await ingest.waitForRun('memory-run-1');

    await expect(access(join(project.projectDir, '.ktx/db.sqlite'))).resolves.toBeUndefined();
    await expectPathMissing(join(project.projectDir, '.ktx/memory-runs/memory-run-1.json'));

    await expect(ingest.status('memory-run-1')).resolves.toMatchObject({
      runId: 'memory-run-1',
      status: 'done',
      done: true,
      captured: { wiki: ['revenue'], sl: [], xrefs: [] },
      skillsLoaded: ['wiki_capture'],
      signalDetected: true,
    });

    await expect(readFile(join(project.projectDir, 'wiki/global/revenue.md'), 'utf-8')).resolves.toContain(
      'Revenue means paid order value net of refunds.',
    );
  });

  it('captures a semantic-layer source for a named local connection id', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.warehouse = { driver: 'postgres' };
    const agentRunner = {
      runLoop: async ({
        toolSet,
      }: {
        toolSet: Record<string, { execute: (input: unknown, options?: { toolCallId?: string }) => Promise<unknown> }>;
      }) => {
        await toolSet.load_skill.execute({ name: 'sl' });
        await toolSet.sl_write_source.execute(
          {
            connectionId: 'warehouse',
            sourceName: 'orders',
            source: {
              name: 'orders',
              table: 'public.orders',
              grain: ['id'],
              columns: [{ name: 'id', type: 'number' }],
              joins: [],
              measures: [{ name: 'order_count', expr: 'count(*)' }],
            },
          },
          { toolCallId: 'sl-write' },
        );
        return { stopReason: 'natural' as const };
      },
    };

    const ingest = createLocalProjectMemoryIngest(project, {
      agentRunner: agentRunner as never,
      runIdFactory: () => 'memory-run-2',
    });

    await ingest.ingest({
      userId: 'local-user',
      chatId: 'chat-2',
      userMessage: 'going forward define orders count as count of public orders',
      assistantMessage: 'Captured.',
      connectionId: 'warehouse',
      sourceType: 'external_ingest',
    });
    await ingest.waitForRun('memory-run-2');

    await expect(access(join(project.projectDir, '.ktx/db.sqlite'))).resolves.toBeUndefined();
    await expectPathMissing(join(project.projectDir, '.ktx/memory-runs/memory-run-2.json'));

    await expect(ingest.status('memory-run-2')).resolves.toMatchObject({
      runId: 'memory-run-2',
      status: 'done',
      captured: { wiki: [], sl: ['orders'], xrefs: [] },
      skillsLoaded: ['sl'],
      signalDetected: true,
    });
    await expect(readFile(join(project.projectDir, 'semantic-layer/warehouse/orders.yaml'), 'utf-8')).resolves.toContain(
      'order_count',
    );
  });
});
