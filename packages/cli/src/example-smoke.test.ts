import { execFile } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const CLI_BIN = resolve(process.cwd(), 'dist/bin.js');
const EXAMPLE_DIR = resolve(process.cwd(), '../../examples/local-warehouse');

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ExecFailure extends Error {
  code?: number;
  stdout?: string;
  stderr?: string;
}

function isExecFailure(error: unknown): error is ExecFailure {
  return error instanceof Error && ('stdout' in error || 'stderr' in error || 'code' in error);
}

async function runBuiltCli(args: string[]): Promise<CliResult> {
  try {
    const result = await execFileAsync(process.execPath, [CLI_BIN, ...args], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    if (!isExecFailure(error)) {
      throw error;
    }
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message,
    };
  }
}

function parseJsonOutput<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

async function copyExampleProject(tempDir: string): Promise<string> {
  const projectDir = join(tempDir, 'local-warehouse');
  await cp(EXAMPLE_DIR, projectDir, { recursive: true });
  return projectDir;
}

describe('standalone local warehouse example', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-example-smoke-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('runs local CLI commands against the copied example project', async () => {
    const projectDir = await copyExampleProject(tempDir);
    const sourceDir = join(projectDir, 'source');

    const knowledgeList = await runBuiltCli(['agent', 'wiki', 'search', 'revenue', '--json', '--project-dir', projectDir]);
    expect(knowledgeList).toMatchObject({ code: 0, stderr: '' });
    expect(parseJsonOutput<{ results: Array<{ key: string; summary: string }> }>(knowledgeList.stdout).results).toContainEqual(
      expect.objectContaining({ key: 'revenue', summary: 'Paid order value after refunds' }),
    );

    const knowledgeRead = await runBuiltCli(['agent', 'wiki', 'read', 'revenue', '--json', '--project-dir', projectDir]);
    expect(knowledgeRead).toMatchObject({ code: 0, stderr: '' });
    expect(parseJsonOutput<{ content: string }>(knowledgeRead.stdout).content).toContain(
      'Revenue is paid order amount after refund adjustments.',
    );

    const slList = await runBuiltCli(['agent', 'sl', 'list', '--json', '--project-dir', projectDir, '--connection-id', 'warehouse']);
    expect(slList).toMatchObject({ code: 0, stderr: '' });
    expect(parseJsonOutput<{ sources: Array<{ connectionId: string; name: string; columnCount: number }> }>(slList.stdout).sources).toContainEqual(
      expect.objectContaining({ connectionId: 'warehouse', name: 'orders', columnCount: 3 }),
    );

    const slRead = await runBuiltCli([
      'agent',
      'sl',
      'read',
      'orders',
      '--json',
      '--connection-id',
      'warehouse',
      '--project-dir',
      projectDir,
    ]);
    expect(slRead).toMatchObject({ code: 0, stderr: '' });
    expect(parseJsonOutput<{ yaml: string }>(slRead.stdout).yaml).toContain('name: orders');

    const ingest = await runBuiltCli([
      'ingest',
      'run',
      '--project-dir',
      projectDir,
      '--connection-id',
      'warehouse',
      '--adapter',
      'fake',
      '--source-dir',
      sourceDir,
    ]);
    expect(ingest).toMatchObject({ code: 1, stdout: '' });
    expect(ingest.stderr).toContain(
      'ktx ingest run requires llm.provider.backend: anthropic, vertex, or gateway, or an injected agentRunner',
    );
  }, 30_000);

});
