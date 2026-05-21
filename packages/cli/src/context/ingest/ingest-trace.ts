import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type IngestTraceLevel = 'info' | 'debug' | 'trace' | 'error';

const TRACE_LEVEL_RANK: Record<IngestTraceLevel, number> = {
  error: 0,
  info: 1,
  debug: 2,
  trace: 3,
};

export interface IngestTraceContext {
  tracePath: string;
  jobId: string;
  connectionId: string;
  sourceKey: string;
  runId?: string;
  syncId?: string;
  level?: IngestTraceLevel;
}

export interface IngestTraceEvent {
  schemaVersion: 1;
  at: string;
  level: IngestTraceLevel;
  jobId: string;
  connectionId: string;
  sourceKey: string;
  runId?: string;
  syncId?: string;
  phase: string;
  event: string;
  durationMs?: number;
  data?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

export interface IngestTraceWriter {
  readonly tracePath: string;
  readonly context: IngestTraceContext;
  withContext(context: Partial<Pick<IngestTraceContext, 'runId' | 'syncId'>>): IngestTraceWriter;
  event(
    level: IngestTraceLevel,
    phase: string,
    event: string,
    data?: Record<string, unknown>,
    error?: unknown,
    durationMs?: number,
  ): Promise<void>;
}

export function ingestTracePathForJob(homeDir: string, jobId: string): string {
  return join(homeDir, 'ingest-traces', jobId, 'trace.jsonl');
}

function serializeError(error: unknown): IngestTraceEvent['error'] | undefined {
  if (error === undefined || error === null) {
    return undefined;
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: 'Error', message: String(error) };
}

function shouldWrite(configured: IngestTraceLevel, incoming: IngestTraceLevel): boolean {
  return TRACE_LEVEL_RANK[incoming] <= TRACE_LEVEL_RANK[configured];
}

export class FileIngestTraceWriter implements IngestTraceWriter {
  readonly tracePath: string;
  readonly context: IngestTraceContext;

  constructor(context: IngestTraceContext) {
    this.context = { ...context, level: context.level ?? 'debug' };
    this.tracePath = context.tracePath;
  }

  withContext(context: Partial<Pick<IngestTraceContext, 'runId' | 'syncId'>>): IngestTraceWriter {
    return new FileIngestTraceWriter({ ...this.context, ...context, tracePath: this.tracePath });
  }

  async event(
    level: IngestTraceLevel,
    phase: string,
    event: string,
    data?: Record<string, unknown>,
    error?: unknown,
    durationMs?: number,
  ): Promise<void> {
    if (!shouldWrite(this.context.level ?? 'debug', level)) {
      return;
    }
    const serializedError = serializeError(error);
    const payload: IngestTraceEvent = {
      schemaVersion: 1,
      at: new Date().toISOString(),
      level,
      jobId: this.context.jobId,
      connectionId: this.context.connectionId,
      sourceKey: this.context.sourceKey,
      ...(this.context.runId ? { runId: this.context.runId } : {}),
      ...(this.context.syncId ? { syncId: this.context.syncId } : {}),
      phase,
      event,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(data ? { data } : {}),
      ...(serializedError ? { error: serializedError } : {}),
    };
    await mkdir(dirname(this.tracePath), { recursive: true });
    await appendFile(this.tracePath, `${JSON.stringify(payload)}\n`, 'utf-8');
  }
}

export class NoopIngestTraceWriter implements IngestTraceWriter {
  readonly tracePath = '';
  readonly context: IngestTraceContext = {
    tracePath: '',
    jobId: '',
    connectionId: '',
    sourceKey: '',
    level: 'error',
  };

  withContext(): IngestTraceWriter {
    return this;
  }

  async event(): Promise<void> {}
}

export async function traceTimed<T>(
  trace: IngestTraceWriter,
  phase: string,
  event: string,
  data: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  await trace.event('debug', phase, `${event}_started`, data);
  const started = Date.now();
  try {
    const result = await fn();
    await trace.event('debug', phase, `${event}_finished`, data, undefined, Date.now() - started);
    return result;
  } catch (error) {
    await trace.event('error', phase, `${event}_failed`, data, error, Date.now() - started);
    throw error;
  }
}
