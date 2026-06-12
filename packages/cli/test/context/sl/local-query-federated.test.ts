import { describe, expect, it, vi } from 'vitest';
import type { KtxSemanticLayerComputePort } from '../../../src/context/daemon/semantic-layer-compute.js';
import type { KtxLocalProject } from '../../../src/context/project/project.js';
import { compileLocalSlQuery } from '../../../src/context/sl/local-query.js';

function makeFakeProject(): KtxLocalProject {
  const fileStore = {
    listFiles: vi.fn(async () => ({ files: [] })),
    readFile: vi.fn(async () => ({ content: '' })),
    writeFile: vi.fn(async () => ({})),
    deleteFile: vi.fn(async () => ({})),
    fileHistory: vi.fn(async () => []),
    headCommit: vi.fn(async () => null),
  } as unknown as KtxLocalProject['fileStore'];

  return {
    projectDir: '/tmp/fake-ktx-project',
    configPath: '/tmp/fake-ktx-project/ktx.yaml',
    config: {
      connections: {
        pg_books: { driver: 'postgres' },
        sqlite_reviews: { driver: 'sqlite' },
      },
      storage: { state: 'sqlite', search: 'sqlite-fts5', git: {} },
      llm: {},
      ingest: {},
      agent: {},
      scan: {},
    } as unknown as KtxLocalProject['config'],
    coreConfig: {} as KtxLocalProject['coreConfig'],
    git: {} as KtxLocalProject['git'],
    fileStore,
  };
}

function makeFakeCompute(): KtxSemanticLayerComputePort & { lastDialect: string | undefined } {
  const fake = {
    lastDialect: undefined as string | undefined,
    query: vi.fn(async (input: { dialect: string; query: unknown; sources: unknown[] }) => {
      fake.lastDialect = input.dialect;
      return {
        sql: 'select 1',
        dialect: input.dialect,
        columns: [],
        plan: { measures: [], dimensions: [] },
      };
    }),
    validateSources: vi.fn(),
    generateSources: vi.fn(),
  };
  return fake;
}

describe('compileLocalSlQuery — federated dialect', () => {
  it('compiles federated queries with the duckdb dialect', async () => {
    const project = makeFakeProject();
    const compute = makeFakeCompute();

    await compileLocalSlQuery(project, {
      connectionId: '_ktx_federated',
      query: { measures: [], dimensions: [] },
      compute,
      execute: false,
    });

    expect(compute.lastDialect).toBe('duckdb');
  });

  it('still uses the driver dialect for a normal connection', async () => {
    const project = makeFakeProject();
    const compute = makeFakeCompute();

    await compileLocalSlQuery(project, {
      connectionId: 'pg_books',
      query: { measures: [], dimensions: [] },
      compute,
      execute: false,
    });

    expect(compute.lastDialect).toBe('postgres');
  });
});
