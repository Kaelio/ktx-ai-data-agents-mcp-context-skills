import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mcpDaemonLayout,
  readKtxMcpDaemonStatus,
  startKtxMcpDaemon,
  stopKtxMcpDaemon,
  type KtxMcpDaemonChild,
  type KtxMcpDaemonState,
} from './managed-mcp-daemon.js';

function child(pid = 4242): KtxMcpDaemonChild {
  return { pid, unref: vi.fn() };
}

function state(projectDir: string, overrides: Partial<KtxMcpDaemonState> = {}): KtxMcpDaemonState {
  return {
    schemaVersion: 1,
    pid: 4242,
    host: '127.0.0.1',
    port: 7878,
    tokenAuth: false,
    projectDir,
    startedAt: '2026-05-14T00:00:00.000Z',
    logPath: join(projectDir, '.ktx/logs/mcp.log'),
    ...overrides,
  };
}

describe('managed MCP daemon lifecycle', () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-mcp-daemon-'));
    projectDir = join(tempDir, 'project');
    await mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('uses the spec state and log paths', () => {
    expect(mcpDaemonLayout(projectDir)).toEqual({
      statePath: join(projectDir, '.ktx/mcp.json'),
      logPath: join(projectDir, '.ktx/logs/mcp.log'),
    });
  });

  it('starts a detached child and writes state without the token value', async () => {
    const spawnDaemon = vi.fn(() => child(5555));
    await startKtxMcpDaemon({
      projectDir,
      cliVersion: '0.0.0-test',
      host: '0.0.0.0',
      port: 7879,
      token: 'secret-token',
      allowedHosts: ['mcp.example.test'],
      allowedOrigins: ['https://mcp.example.test'],
      binPath: '/repo/packages/cli/dist/bin.js',
      spawnDaemon,
      processAlive: vi.fn(() => false),
      portAvailable: vi.fn(async () => true),
      now: () => new Date('2026-05-14T00:00:00.000Z'),
    });

    expect(spawnDaemon).toHaveBeenCalledWith(
      process.execPath,
      [
        '/repo/packages/cli/dist/bin.js',
        '--project-dir',
        projectDir,
        'mcp',
        'serve-internal',
        '--host',
        '0.0.0.0',
        '--port',
        '7879',
        '--allowed-host',
        'mcp.example.test',
        '--allowed-origin',
        'https://mcp.example.test',
      ],
      expect.objectContaining({
        detached: true,
        env: expect.objectContaining({ KTX_MCP_TOKEN: 'secret-token' }),
      }),
    );
    expect(JSON.stringify(JSON.parse(await readFile(join(projectDir, '.ktx/mcp.json'), 'utf8')))).not.toContain(
      'secret-token',
    );
  });

  it('reports running when the process is alive and health passes', async () => {
    await mkdir(join(projectDir, '.ktx'), { recursive: true });
    await writeFile(join(projectDir, '.ktx/mcp.json'), `${JSON.stringify(state(projectDir), null, 2)}\n`);

    const status = await readKtxMcpDaemonStatus({
      projectDir,
      processAlive: vi.fn(() => true),
      fetchHealth: vi.fn(async () => ({ ok: true, body: { status: 'ok', projectDir, port: 7878 } })),
    });

    expect(status.kind).toBe('running');
    if (status.kind !== 'running') {
      throw new Error(`Expected running status, received ${status.kind}`);
    }
    expect(status.url).toBe('http://127.0.0.1:7878/mcp');
  });

  it('stops a recorded daemon and removes state', async () => {
    await mkdir(join(projectDir, '.ktx'), { recursive: true });
    await writeFile(join(projectDir, '.ktx/mcp.json'), `${JSON.stringify(state(projectDir), null, 2)}\n`);
    const alive = new Set([4242]);
    const killProcess = vi.fn((pid: number) => alive.delete(pid));

    await expect(
      stopKtxMcpDaemon({
        projectDir,
        processAlive: vi.fn((pid) => alive.has(pid)),
        killProcess,
        stopGraceMs: 1,
        pollIntervalMs: 1,
      }),
    ).resolves.toEqual({ status: 'stopped' });

    expect(killProcess).toHaveBeenCalledWith(4242, 'SIGTERM');
    await expect(readFile(join(projectDir, '.ktx/mcp.json'), 'utf8')).rejects.toThrow();
  });
});
