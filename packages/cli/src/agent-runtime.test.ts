import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KTX_AGENT_MAX_ROWS_CAP,
  createKtxAgentRuntime,
  parseAgentMaxRows,
  readAgentJsonFile,
  writeAgentJson,
  writeAgentJsonError,
} from './agent-runtime.js';

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write: (chunk: string) => (stdout += chunk) },
      stderr: { write: (chunk: string) => (stderr += chunk) },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe('agent runtime helpers', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-agent-runtime-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('writes JSON success and error envelopes without color or spinners', () => {
    const successIo = makeIo();
    const errorIo = makeIo();

    writeAgentJson(successIo.io, { ok: true });
    writeAgentJsonError(errorIo.io, 'missing source', { code: 'NOT_FOUND' });

    expect(JSON.parse(successIo.stdout())).toEqual({ ok: true });
    expect(successIo.stderr()).toBe('');
    expect(JSON.parse(errorIo.stderr())).toEqual({
      ok: false,
      error: { message: 'missing source', code: 'NOT_FOUND' },
    });
    expect(errorIo.stdout()).toBe('');
  });

  it('reads JSON query files as objects', async () => {
    const path = join(tempDir, 'query.json');
    await writeFile(path, '{"measures":["revenue"],"limit":50}', 'utf-8');

    await expect(readAgentJsonFile(path)).resolves.toEqual({ measures: ['revenue'], limit: 50 });
  });

  it('rejects non-object JSON query files', async () => {
    const path = join(tempDir, 'query.json');
    await writeFile(path, '["revenue"]', 'utf-8');

    await expect(readAgentJsonFile(path)).rejects.toThrow('must contain a JSON object');
  });

  it('requires positive row limits and enforces the agent cap', () => {
    expect(parseAgentMaxRows(100)).toBe(100);
    expect(() => parseAgentMaxRows(undefined)).toThrow('maxRows is required');
    expect(() => parseAgentMaxRows(0)).toThrow('positive integer');
    expect(() => parseAgentMaxRows(KTX_AGENT_MAX_ROWS_CAP + 1)).toThrow(String(KTX_AGENT_MAX_ROWS_CAP));
  });

  it('constructs local context ports with semantic compute and query executor', async () => {
    const project = {
      projectDir: tempDir,
      configPath: join(tempDir, 'ktx.yaml'),
      config: { project: 'revenue', connections: {} },
      coreConfig: {},
      git: {},
      fileStore: {},
    } as never;
    const ports = { knowledge: {}, semanticLayer: {} } as never;
    const semanticLayerCompute = { query: vi.fn(), validateSources: vi.fn(), generateSources: vi.fn() };
    const queryExecutor = { execute: vi.fn() };
    const loadProject = vi.fn(async () => project);
    const createContextTools = vi.fn(() => ports);

    await expect(
      createKtxAgentRuntime(
        { projectDir: tempDir, enableSemanticCompute: true, enableQueryExecution: true },
        {
          loadProject,
          createContextTools,
          createSemanticLayerCompute: () => semanticLayerCompute,
          createQueryExecutor: () => queryExecutor,
        },
      ),
    ).resolves.toMatchObject({ project, ports, queryExecutor });

    expect(loadProject).toHaveBeenCalledWith({ projectDir: tempDir });
    expect(createContextTools).toHaveBeenCalledWith(project, {
      semanticLayerCompute,
      queryExecutor,
    });
  });

  it('creates managed semantic compute when no test override is injected', async () => {
    const project = {
      projectDir: tempDir,
      configPath: join(tempDir, 'ktx.yaml'),
      config: { project: 'revenue', connections: {} },
      coreConfig: {},
      git: {},
      fileStore: {},
    } as never;
    const ports = { semanticLayer: {} } as never;
    const semanticLayerCompute = { query: vi.fn(), validateSources: vi.fn(), generateSources: vi.fn() };
    const loadProject = vi.fn(async () => project);
    const createContextTools = vi.fn(() => ports);
    const createManagedSemanticLayerCompute = vi.fn(async () => semanticLayerCompute);
    const { io } = makeIo();

    await expect(
      createKtxAgentRuntime(
        {
          projectDir: tempDir,
          enableSemanticCompute: true,
          enableQueryExecution: false,
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'auto',
          io,
        },
        {
          loadProject,
          createContextTools,
          createManagedSemanticLayerCompute,
        },
      ),
    ).resolves.toMatchObject({ project, ports, semanticLayerCompute });

    expect(createManagedSemanticLayerCompute).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      installPolicy: 'auto',
      io,
    });
    expect(createContextTools).toHaveBeenCalledWith(project, {
      semanticLayerCompute,
    });
  });
});
