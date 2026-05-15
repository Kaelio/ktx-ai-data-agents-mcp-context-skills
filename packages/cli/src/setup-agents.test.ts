import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readKtxSetupState } from '@ktx/context/project';
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
    await writeFile(join(tempDir, 'ktx.yaml'), 'connections: {}\n', 'utf-8');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('plans project-scoped CLI and research files for every target', () => {
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'claude-code', scope: 'project', mode: 'cli' })).toEqual([
      { kind: 'file', path: join(tempDir, '.claude/skills/ktx/SKILL.md'), role: 'skill' },
      { kind: 'file', path: join(tempDir, '.claude/skills/ktx-research/SKILL.md'), role: 'research-skill' },
      { kind: 'file', path: join(tempDir, '.claude/rules/ktx.md'), role: 'rule' },
    ]);
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'codex', scope: 'project', mode: 'cli' })).toEqual([
      { kind: 'file', path: join(tempDir, '.agents/skills/ktx/SKILL.md'), role: 'skill' },
      { kind: 'file', path: join(tempDir, '.agents/skills/ktx-research/SKILL.md'), role: 'research-skill' },
      { kind: 'file', path: join(tempDir, '.codex/instructions/ktx.md'), role: 'rule' },
    ]);
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'cursor', scope: 'project', mode: 'cli' })).toEqual([
      { kind: 'file', path: join(tempDir, '.cursor/rules/ktx.mdc') },
      { kind: 'file', path: join(tempDir, '.cursor/rules/ktx-research.mdc'), role: 'research-skill' },
    ]);
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'opencode', scope: 'project', mode: 'cli' })).toEqual([
      { kind: 'file', path: join(tempDir, '.opencode/commands/ktx.md') },
      { kind: 'file', path: join(tempDir, '.opencode/commands/ktx-research.md'), role: 'research-skill' },
    ]);
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'universal', scope: 'project', mode: 'cli' })).toEqual([
      { kind: 'file', path: join(tempDir, '.agents/skills/ktx/SKILL.md') },
      { kind: 'file', path: join(tempDir, '.agents/skills/ktx-research/SKILL.md'), role: 'research-skill' },
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
          mode: 'cli',
          skipAgents: false,
        },
        io.io,
      ),
    ).resolves.toEqual({
      status: 'ready',
      projectDir: tempDir,
      installs: [{ target: 'universal', scope: 'project', mode: 'cli' }],
    });

    await expect(stat(join(tempDir, '.agents/skills/ktx/SKILL.md'))).resolves.toBeDefined();
    const skill = await readFile(join(tempDir, '.agents/skills/ktx/SKILL.md'), 'utf-8');
    expect(skill).toContain(`--project-dir ${tempDir}`);
    expect(skill).toContain('must not print secrets');
    expect(skill).toContain('status --json');
    expect(skill).toContain('sl list --json');
    expect(skill).toContain('sl query');
    expect(skill).toContain('--format json');
    expect(skill).not.toContain('sl query --json');
    expect(skill).not.toContain('agent ');
    expect(skill).not.toContain('sql execute');
    expect(await readKtxAgentInstallManifest(tempDir)).toMatchObject({
      version: 1,
      projectDir: tempDir,
      installs: [{ target: 'universal', scope: 'project', mode: 'cli' }],
    });
    expect(await readKtxSetupState(tempDir)).toEqual({ completed_steps: ['agents'] });
    expect(io.stderr()).toBe('');
  });

  it('installs the research skill from the runtime asset', async () => {
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
          mode: 'cli',
          skipAgents: false,
        },
        io.io,
      ),
    ).resolves.toMatchObject({ status: 'ready' });

    const researchSkill = await readFile(join(tempDir, '.agents/skills/ktx-research/SKILL.md'), 'utf-8');
    expect(researchSkill).toContain('name: ktx-research');
    expect(researchSkill).toContain('Always run `discover_data` before writing SQL.');
    expect(researchSkill).toContain('Treat a `dictionary_search` miss as non-authoritative.');
  });

  it('writes PATH-independent launcher commands for skills', async () => {
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
          mode: 'cli',
          skipAgents: false,
        },
        io.io,
      ),
    ).resolves.toMatchObject({ status: 'ready' });

    const skill = await readFile(join(tempDir, '.agents/skills/ktx/SKILL.md'), 'utf-8');
    expect(skill).not.toContain('`ktx agent');
    expect(skill).toContain('status --json');
    expect(skill).toContain('sl query');
    expect(skill).toContain('--format json');
    expect(skill).not.toContain('sl query --json');
    expect(skill).not.toContain('sql execute');
  });

  it('writes Claude Code project MCP config and tracks the json key', async () => {
    const io = makeIo();

    await expect(
      runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'disabled',
          yes: true,
          agents: true,
          target: 'claude-code',
          scope: 'project',
          mode: 'cli',
          skipAgents: false,
        },
        io.io,
      ),
    ).resolves.toMatchObject({ status: 'ready' });

    const mcpJson = JSON.parse(await readFile(join(tempDir, '.mcp.json'), 'utf-8')) as {
      mcpServers: { ktx: { type: string; url: string; headers?: Record<string, string> } };
    };
    expect(mcpJson.mcpServers.ktx).toEqual({ type: 'http', url: 'http://localhost:7878/mcp' });
    expect(await readKtxAgentInstallManifest(tempDir)).toMatchObject({
      entries: expect.arrayContaining([{ kind: 'json-key', path: join(tempDir, '.mcp.json'), jsonPath: ['mcpServers', 'ktx'] }]),
    });
    expect(io.stdout()).toContain('Run `ktx mcp start` to enable the configured KTX MCP server.');
  });

  it('writes Cursor project MCP config', async () => {
    const io = makeIo();

    await runKtxSetupAgentsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        yes: true,
        agents: true,
        target: 'cursor',
        scope: 'project',
        mode: 'cli',
        skipAgents: false,
      },
      io.io,
    );

    const cursorJson = JSON.parse(await readFile(join(tempDir, '.cursor/mcp.json'), 'utf-8')) as {
      mcpServers: { ktx: { url: string; headers?: Record<string, string> } };
    };
    expect(cursorJson.mcpServers.ktx).toEqual({ url: 'http://localhost:7878/mcp' });
  });

  it('prints Codex and opencode snippets without mutating printed-only config files', async () => {
    const codexIo = makeIo();
    await runKtxSetupAgentsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        yes: true,
        agents: true,
        target: 'codex',
        scope: 'project',
        mode: 'cli',
        skipAgents: false,
      },
      codexIo.io,
    );
    expect(codexIo.stdout()).toContain('[mcp_servers.ktx]');
    expect(codexIo.stdout()).toContain('url = "http://localhost:7878/mcp"');

    const opencodeIo = makeIo();
    await runKtxSetupAgentsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        yes: true,
        agents: true,
        target: 'opencode',
        scope: 'project',
        mode: 'cli',
        skipAgents: false,
      },
      opencodeIo.io,
    );
    expect(opencodeIo.stdout()).toContain('"mcp"');
    expect(opencodeIo.stdout()).toContain('"type": "remote"');
    await expect(readFile(join(tempDir, 'opencode.json'), 'utf-8')).rejects.toThrow();
  });

  it('uses MCP daemon state for port and token metadata without rendering literal tokens', async () => {
    await mkdir(join(tempDir, '.ktx'), { recursive: true });
    await writeFile(
      join(tempDir, '.ktx/mcp.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          pid: 999999,
          host: '127.0.0.1',
          port: 8787,
          tokenAuth: true,
          projectDir: tempDir,
          startedAt: '2026-05-14T00:00:00.000Z',
          logPath: join(tempDir, '.ktx/logs/mcp.log'),
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );
    const io = makeIo();
    const previousToken = process.env.KTX_MCP_TOKEN;
    process.env.KTX_MCP_TOKEN = 'secret-token';

    try {
      await runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'disabled',
          yes: true,
          agents: true,
          target: 'claude-code',
          scope: 'project',
          mode: 'cli',
          skipAgents: false,
        },
        io.io,
      );

      const rendered = JSON.stringify(JSON.parse(await readFile(join(tempDir, '.mcp.json'), 'utf-8')));
      expect(rendered).toContain('http://127.0.0.1:8787/mcp');
      expect(rendered).toContain('Bearer ${KTX_MCP_TOKEN}');
      expect(rendered).not.toContain('secret-token');
      expect(io.stdout()).toContain('Run `ktx mcp start` to enable the configured KTX MCP server.');
    } finally {
      if (previousToken === undefined) {
        delete process.env.KTX_MCP_TOKEN;
      } else {
        process.env.KTX_MCP_TOKEN = previousToken;
      }
    }
  });

  it('writes Claude Code local MCP config under the project key in ~/.claude.json', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ktx-setup-agents-home-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const io = makeIo();
      await runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'disabled',
          yes: true,
          agents: true,
          target: 'claude-code',
          scope: 'local',
          mode: 'cli',
          skipAgents: false,
        },
        io.io,
      );

      const config = JSON.parse(await readFile(join(home, '.claude.json'), 'utf-8')) as {
        projects: Record<string, { mcpServers: { ktx: { type: string; url: string } } }>;
      };
      expect(config.projects[tempDir].mcpServers.ktx).toEqual({ type: 'http', url: 'http://localhost:7878/mcp' });
    } finally {
      process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('removes only manifest-listed files', async () => {
    const io = makeIo();
    await runKtxSetupAgentsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        yes: true,
          agents: true,
          target: 'claude-code',
          scope: 'project',
          mode: 'cli',
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

  it('treats cancel as skip in interactive mode', async () => {
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
    ).resolves.toEqual({ status: 'skipped', projectDir: tempDir });
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
        mode: 'cli',
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
  });

  it('formats summary with relative paths for project scope', () => {
    const summary = formatInstallSummary(
      [{ target: 'cursor', scope: 'project', mode: 'cli' }],
      [{ kind: 'file', path: join(tempDir, '.cursor/rules/ktx.mdc') }],
      tempDir,
    );

    expect(summary).toContain('Cursor');
    expect(summary).toContain('+ Rule installed — tells your agent when to use KTX');
    expect(summary).toContain('.cursor/rules/ktx.mdc');
    expect(summary).not.toContain(tempDir);
  });

  it('formats summary with multiple agent targets', () => {
    const summary = formatInstallSummary(
      [
        { target: 'claude-code', scope: 'project', mode: 'cli' },
        { target: 'codex', scope: 'project', mode: 'cli' },
      ],
      [
        { kind: 'file', path: join(tempDir, '.claude/skills/ktx/SKILL.md'), role: 'skill' },
        { kind: 'file', path: join(tempDir, '.claude/rules/ktx.md'), role: 'rule' },
        { kind: 'file', path: join(tempDir, '.agents/skills/ktx/SKILL.md'), role: 'skill' },
        { kind: 'file', path: join(tempDir, '.codex/instructions/ktx.md'), role: 'rule' },
      ],
      tempDir,
    );

    expect(summary).toContain('Claude Code');
    expect(summary).toContain('+ Skill installed — teaches your agent which KTX commands to run');
    expect(summary).toContain('+ Rule installed — tells your agent when to use KTX');
    expect(summary).toContain('Codex');
    expect(summary).toContain('.agents/skills/ktx/SKILL.md');
  });
});
