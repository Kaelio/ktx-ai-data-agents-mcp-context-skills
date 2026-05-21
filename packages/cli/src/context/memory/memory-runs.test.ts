import { describe, expect, it, vi } from 'vitest';
import type { MemoryAgentInput, MemoryAgentResult } from '../../context/memory/types.js';
import type { MemoryAgentService } from '../../context/memory/memory-agent.service.js';
import { MemoryIngestService, type MemoryRunStorePort } from './memory-runs.js';

class InMemoryRunStore implements MemoryRunStorePort {
  readonly rows = new Map<
    string,
    {
      id: string;
      status: 'running' | 'done' | 'error';
      stage: string;
      inputHash: string;
      chatId: string | null;
      outputSummary: MemoryAgentResult | null;
      error: string | null;
    }
  >();

  async createRunning(args: { inputHash: string; chatId?: string | null }): Promise<{ id: string }> {
    const id = `run-${this.rows.size + 1}`;
    this.rows.set(id, {
      id,
      status: 'running',
      stage: 'queued',
      inputHash: args.inputHash,
      chatId: args.chatId ?? null,
      outputSummary: null,
      error: null,
    });
    return { id };
  }

  async markRunning(id: string, stage: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row) {
      throw new Error(`unknown run ${id}`);
    }
    row.stage = stage;
  }

  async markDone(id: string, outputSummary: MemoryAgentResult): Promise<void> {
    const row = this.rows.get(id);
    if (!row) {
      throw new Error(`unknown run ${id}`);
    }
    row.status = 'done';
    row.stage = 'done';
    row.outputSummary = outputSummary;
  }

  async markError(id: string, error: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row) {
      throw new Error(`unknown run ${id}`);
    }
    row.status = 'error';
    row.stage = 'error';
    row.error = error;
  }

  async findById(id: string) {
    return this.rows.get(id) ?? null;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function buildService(): {
  ingest: MemoryIngestService;
  store: InMemoryRunStore;
  memoryAgentIngest: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof deferred<MemoryAgentResult>>;
} {
  const store = new InMemoryRunStore();
  const run = deferred<MemoryAgentResult>();
  const memoryAgentIngest = vi.fn<MemoryAgentService['ingest']>().mockReturnValue(run.promise);
  const memoryAgent = { ingest: memoryAgentIngest };
  return {
    ingest: new MemoryIngestService({ memoryAgent, runs: store }),
    store,
    memoryAgentIngest,
    run,
  };
}

describe('MemoryIngestService', () => {
  it('creates a run, executes memory ingest, and stores a done summary', async () => {
    const result: MemoryAgentResult = {
      signalDetected: true,
      actions: [{ target: 'wiki', type: 'created', key: 'revenue', detail: 'captured revenue definition' }],
      skillsLoaded: ['wiki_capture'],
      commitHash: 'abc123',
    };
    const { ingest, store, memoryAgentIngest, run } = buildService();

    const input: MemoryAgentInput = {
      userId: 'user-1',
      chatId: 'chat-1',
      userMessage: 'Revenue means paid order value.',
      assistantMessage: 'Captured.',
      connectionId: '00000000-0000-0000-0000-000000000001',
    };

    const started = await ingest.ingest(input);

    expect(started.runId).toBe('run-1');
    expect(memoryAgentIngest).toHaveBeenCalledWith(input);
    await expect(ingest.status(started.runId)).resolves.toMatchObject({
      runId: 'run-1',
      status: 'running',
      stage: 'ingesting',
      done: false,
    });

    run.resolve(result);
    await ingest.waitForRun(started.runId);

    const status = await ingest.status(started.runId);
    expect(status).toEqual({
      runId: 'run-1',
      stage: 'done',
      done: true,
      status: 'done',
      captured: {
        wiki: ['revenue'],
        sl: [],
        xrefs: [],
      },
      error: null,
      commitHash: 'abc123',
      skillsLoaded: ['wiki_capture'],
      signalDetected: true,
    });
    expect(store.rows.get('run-1')?.inputHash).toHaveLength(64);
  });

  it('stores no-signal ingests as done with empty captured arrays', async () => {
    const { ingest, run } = buildService();

    const started = await ingest.ingest({
      userId: 'user-1',
      chatId: 'chat-2',
      userMessage: 'Thanks.',
    });

    run.resolve({
      signalDetected: false,
      actions: [],
      skillsLoaded: [],
      commitHash: null,
    });
    await ingest.waitForRun(started.runId);

    await expect(ingest.status(started.runId)).resolves.toMatchObject({
      done: true,
      status: 'done',
      captured: { wiki: [], sl: [], xrefs: [] },
      signalDetected: false,
    });
  });

  it('stores thrown errors and projects them as failed statuses', async () => {
    const store = new InMemoryRunStore();
    const memoryAgent = {
      ingest: vi.fn<MemoryAgentService['ingest']>().mockRejectedValue(new Error('LLM provider missing')),
    };
    const ingest = new MemoryIngestService({ memoryAgent, runs: store });

    const started = await ingest.ingest({
      userId: 'user-1',
      chatId: 'chat-3',
      userMessage: 'Remember this.',
    });
    await ingest.waitForRun(started.runId);

    await expect(ingest.status(started.runId)).resolves.toMatchObject({
      done: true,
      status: 'error',
      stage: 'error',
      captured: { wiki: [], sl: [], xrefs: [] },
      error: 'LLM provider missing',
    });
  });

  it('returns null for an unknown run id', async () => {
    const { ingest } = buildService();

    await expect(ingest.status('missing')).resolves.toBeNull();
  });
});
