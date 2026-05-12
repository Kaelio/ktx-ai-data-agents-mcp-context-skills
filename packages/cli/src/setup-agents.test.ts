import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatInstallSummary,
  plannedKtxAgentFiles,
  readKtxAgentInstallManifest,
  removeKtxAgentInstall,
  runKtxSetupAgentsStep,
} from './setup-agents.js';

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

describe('setup agents', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-setup-agents-'));
    await mkdir(join(tempDir, '.ktx', 'agents'), { recursive: true });
    await writeFile(join(tempDir, 'ktx.yaml'), 'project: revenue\nconnections: {}\n', 'utf-8');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('plans project-scoped CLI and MCP files for every target', () => {
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'claude-code', scope: 'project', mode: 'both' })).toEqual([
      { kind: 'file', path: join(tempDir, '.claude/skills/ktx/SKILL.md'), role: 'skill' },
      { kind: 'file', path: join(tempDir, '.claude/rules/ktx.md'), role: 'rule' },
      { kind: 'json-key', path: join(tempDir, '.mcp.json'), jsonPath: ['mcpServers', 'ktx'] },
    ]);
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'codex', scope: 'project', mode: 'cli' })).toEqual([
      { kind: 'file', path: join(tempDir, '.agents/skills/ktx/SKILL.md'), role: 'skill' },
      { kind: 'file', path: join(tempDir, '.codex/instructions/ktx.md'), role: 'rule' },
    ]);
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'cursor', scope: 'project', mode: 'mcp' })).toEqual([
      { kind: 'json-key', path: join(tempDir, '.cursor/mcp.json'), jsonPath: ['mcpServers', 'ktx'] },
    ]);
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'opencode', scope: 'project', mode: 'cli' })).toEqual([
      { kind: 'file', path: join(tempDir, '.opencode/commands/ktx.md') },
    ]);
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'universal', scope: 'project', mode: 'both' })).toEqual([
      { kind: 'file', path: join(tempDir, '.agents/skills/ktx/SKILL.md') },
      { kind: 'json-key', path: join(tempDir, '.agents/mcp/ktx.json'), jsonPath: ['mcpServers', 'ktx'] },
    ]);
  });

  it('installs target files, writes a manifest, and marks agents complete', async () => {
    const io = makeIo();

    await expect(
      runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'disabled',
          yes: true,
          agents: true,
          target: 'universal',
          scope: 'project',
          mode: 'both',
          skipAgents: false,
        },
        io.io,
      ),
    ).resolves.toEqual({
      status: 'ready',
      projectDir: tempDir,
      installs: [{ target: 'universal', scope: 'project', mode: 'both' }],
    });

    await expect(stat(join(tempDir, '.agents/skills/ktx/SKILL.md'))).resolves.toBeDefined();
    await expect(stat(join(tempDir, '.agents/mcp/ktx.json'))).resolves.toBeDefined();
    const skill = await readFile(join(tempDir, '.agents/skills/ktx/SKILL.md'), 'utf-8');
    expect(skill).toContain(`--project-dir ${tempDir}`);
    expect(skill).toContain('must not print secrets');
    expect(skill).toContain('agent sql execute');
    expect(await readKtxAgentInstallManifest(tempDir)).toMatchObject({
      version: 1,
      projectDir: tempDir,
      installs: [{ target: 'universal', scope: 'project', mode: 'both' }],
    });
    expect(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).toContain('agents');
    expect(io.stderr()).toBe('');
  });

  it('writes PATH-independent launcher commands for skills and MCP configs', async () => {
    const io = makeIo();

    await expect(
      runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'disabled',
          yes: true,
          agents: true,
          target: 'universal',
          scope: 'project',
          mode: 'both',
          skipAgents: false,
        },
        io.io,
      ),
    ).resolves.toMatchObject({ status: 'ready' });

    const skill = await readFile(join(tempDir, '.agents/skills/ktx/SKILL.md'), 'utf-8');
    expect(skill).not.toContain('`ktx agent');
    expect(skill).toContain('agent context --json');
    expect(skill).toContain('agent sql execute');

    const mcp = JSON.parse(await readFile(join(tempDir, '.agents/mcp/ktx.json'), 'utf-8')) as {
      mcpServers?: { ktx?: { command?: string; args?: string[] } };
    };
    expect(mcp.mcpServers?.ktx?.command).toBe(process.execPath);
    expect(mcp.mcpServers?.ktx?.args?.[0]).toMatch(/packages\/cli\/(src|dist)\/bin\.(ts|js)$/);
    expect(mcp.mcpServers?.ktx?.args).toEqual([
      expect.stringMatching(/packages\/cli\/(src|dist)\/bin\.(ts|js)$/),
      '--project-dir',
      tempDir,
      'serve',
      '--mcp',
      'stdio',
      '--semantic-compute',
      '--execute-queries',
    ]);
  });

  it('removes only manifest-listed files and JSON keys', async () => {
    const io = makeIo();
    await runKtxSetupAgentsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        yes: true,
        agents: true,
        target: 'claude-code',
        scope: 'project',
        mode: 'both',
        skipAgents: false,
      },
      io.io,
    );
    await writeFile(join(tempDir, '.claude/skills/ktx/keep.txt'), 'user file', 'utf-8');

    await expect(removeKtxAgentInstall(tempDir, io.io)).resolves.toBe(0);

    await expect(stat(join(tempDir, '.claude/skills/ktx/SKILL.md'))).rejects.toThrow();
    await expect(stat(join(tempDir, '.claude/rules/ktx.md'))).rejects.toThrow();
    await expect(stat(join(tempDir, '.claude/skills/ktx/keep.txt'))).resolves.toBeDefined();
    await expect(readKtxAgentInstallManifest(tempDir)).resolves.toEqual(null);
  });

  it('uses prompts in interactive mode and supports Back', async () => {
    const io = makeIo();
    const prompts = {
      select: vi.fn(async () => 'back'),
      multiselect: vi.fn(async () => ['codex']),
      cancel: vi.fn(),
    };

    await expect(
      runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'auto',
          yes: false,
          agents: true,
          scope: 'project',
          mode: 'cli',
          skipAgents: false,
        },
        io.io,
        { prompts },
      ),
    ).resolves.toEqual({ status: 'back', projectDir: tempDir });
  });

  it('explains how to select multiple agent targets in interactive mode', async () => {
    const io = makeIo();
    const prompts = {
      select: vi.fn(async () => 'cli'),
      multiselect: vi.fn(async () => ['back']),
      cancel: vi.fn(),
    };

    await expect(
      runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'auto',
          yes: false,
          agents: true,
          scope: 'project',
          mode: 'cli',
          skipAgents: false,
        },
        io.io,
        { prompts },
      ),
    ).resolves.toEqual({ status: 'back', projectDir: tempDir });

    expect(prompts.multiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'Which agent targets should KTX install?\nUse Up/Down to move, Space to select or unselect, Enter to confirm, Escape to go back, or Ctrl+C to exit.',
      }),
    );
  });

  it('prints per-agent install summary after successful installation', async () => {
    const io = makeIo();

    await runKtxSetupAgentsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        yes: true,
        agents: true,
        target: 'claude-code',
        scope: 'project',
        mode: 'both',
        skipAgents: false,
      },
      io.io,
    );

    const output = io.stdout();
    expect(output).toContain('Agent integration complete');
    expect(output).toContain('Claude Code');
    expect(output).toContain('+ Skill installed — teaches your agent which KTX commands to run');
    expect(output).toContain('.claude/skills/ktx/SKILL.md');
    expect(output).toContain('+ Rule installed — tells your agent when to use KTX');
    expect(output).toContain('.claude/rules/ktx.md');
    expect(output).toContain('+ MCP config added — lets your agent talk to KTX over MCP');
    expect(output).toContain('.mcp.json');
  });

  it('formats summary with relative paths for project scope', () => {
    const summary = formatInstallSummary(
      [{ target: 'cursor', scope: 'project', mode: 'both' }],
      [
        { kind: 'file', path: join(tempDir, '.cursor/rules/ktx.mdc') },
        { kind: 'json-key', path: join(tempDir, '.cursor/mcp.json'), jsonPath: ['mcpServers', 'ktx'] },
      ],
      tempDir,
    );

    expect(summary).toContain('Cursor');
    expect(summary).toContain('+ Rule installed — tells your agent when to use KTX');
    expect(summary).toContain('.cursor/rules/ktx.mdc');
    expect(summary).toContain('+ MCP config added — lets your agent talk to KTX over MCP');
    expect(summary).toContain('.cursor/mcp.json');
    expect(summary).not.toContain(tempDir);
  });

  it('formats summary with multiple agent targets', () => {
    const summary = formatInstallSummary(
      [
        { target: 'claude-code', scope: 'project', mode: 'cli' },
        { target: 'codex', scope: 'project', mode: 'mcp' },
      ],
      [
        { kind: 'file', path: join(tempDir, '.claude/skills/ktx/SKILL.md'), role: 'skill' },
        { kind: 'file', path: join(tempDir, '.claude/rules/ktx.md'), role: 'rule' },
        { kind: 'json-key', path: join(tempDir, '.agents/mcp/ktx.json'), jsonPath: ['mcpServers', 'ktx'] },
      ],
      tempDir,
    );

    expect(summary).toContain('Claude Code');
    expect(summary).toContain('+ Skill installed — teaches your agent which KTX commands to run');
    expect(summary).toContain('+ Rule installed — tells your agent when to use KTX');
    expect(summary).toContain('Codex');
    expect(summary).toContain('+ MCP config added — lets your agent talk to KTX over MCP');
  });
});
