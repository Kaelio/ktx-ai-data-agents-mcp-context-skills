import { createHash } from 'node:crypto';
import type { MemoryAction, MemoryAgentInput, MemoryAgentResult, MemoryAgentService } from './index.js';

export type MemoryRunStatus = 'running' | 'done' | 'error';

export interface MemoryRunRecord {
  id: string;
  status: MemoryRunStatus;
  stage: string;
  inputHash: string;
  chatId: string | null;
  outputSummary: MemoryAgentResult | null;
  error: string | null;
}

export interface MemoryRunStorePort {
  createRunning(args: { inputHash: string; chatId?: string | null }): Promise<{ id: string }>;
  markRunning(id: string, stage: string): Promise<void>;
  markDone(id: string, outputSummary: MemoryAgentResult): Promise<void>;
  markError(id: string, error: string): Promise<void>;
  findById(id: string): Promise<MemoryRunRecord | null>;
}

export interface MemoryIngestServiceDeps {
  memoryAgent: Pick<MemoryAgentService, 'ingest'>;
  runs: MemoryRunStorePort;
}

export interface MemoryIngestStartResult {
  runId: string;
}

export interface MemoryIngestStatus {
  runId: string;
  status: MemoryRunStatus;
  stage: string;
  done: boolean;
  captured: {
    wiki: string[];
    sl: string[];
    xrefs: string[];
  };
  error: string | null;
  commitHash: string | null;
  skillsLoaded: string[];
  signalDetected: boolean;
}

function inputHash(input: MemoryAgentInput): string {
  const stableInput = JSON.stringify({
    userMessage: input.userMessage,
    assistantMessage: input.assistantMessage ?? '',
    connectionId: input.connectionId ?? null,
  });
  return createHash('sha256').update(stableInput).digest('hex');
}

function capturedKeys(actions: MemoryAction[]): MemoryIngestStatus['captured'] {
  const wiki = new Set<string>();
  const sl = new Set<string>();
  const xrefs = new Set<string>();

  for (const action of actions) {
    if (action.target === 'wiki') {
      wiki.add(action.key);
    } else {
      sl.add(action.key);
    }
    if (action.detail.toLowerCase().includes('xref') || action.detail.toLowerCase().includes('cross-ref')) {
      xrefs.add(action.key);
    }
  }

  return {
    wiki: [...wiki].sort(),
    sl: [...sl].sort(),
    xrefs: [...xrefs].sort(),
  };
}

export class MemoryIngestService {
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly deps: MemoryIngestServiceDeps) {}

  async ingest(input: MemoryAgentInput): Promise<MemoryIngestStartResult> {
    const row = await this.deps.runs.createRunning({
      inputHash: inputHash(input),
      chatId: input.chatId,
    });

    await this.deps.runs.markRunning(row.id, 'ingesting');

    const run = this.runIngest(row.id, input);
    this.inFlight.set(row.id, run);
    run.finally(() => this.inFlight.delete(row.id)).catch(() => undefined);

    return { runId: row.id };
  }

  async waitForRun(runId: string): Promise<void> {
    await this.inFlight.get(runId);
  }

  private async runIngest(runId: string, input: MemoryAgentInput): Promise<void> {
    try {
      const outputSummary = await this.deps.memoryAgent.ingest(input);
      await this.deps.runs.markDone(runId, outputSummary);
    } catch (error) {
      await this.deps.runs.markError(runId, error instanceof Error ? error.message : String(error));
    }
  }

  async status(runId: string): Promise<MemoryIngestStatus | null> {
    const row = await this.deps.runs.findById(runId);
    if (!row) {
      return null;
    }

    const output = row.outputSummary;
    return {
      runId: row.id,
      status: row.status,
      stage: row.stage,
      done: row.status !== 'running',
      captured: output ? capturedKeys(output.actions) : { wiki: [], sl: [], xrefs: [] },
      error: row.error,
      commitHash: output?.commitHash ?? null,
      skillsLoaded: output?.skillsLoaded ?? [],
      signalDetected: output?.signalDetected ?? false,
    };
  }
}
