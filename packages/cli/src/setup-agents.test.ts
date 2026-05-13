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
    await writeFile(join(tempDir, 'ktx.yaml'), 'project: revenue\nconnections: {}\n', 'utf-8');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('plans project-scoped CLI files for every target', () => {
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'claude-code', scope: 'project', mode: 'cli' })).toEqual([
      { kind: 'file', path: join(tempDir, '.claude/skills/ktx/SKILL.md'), role: 'skill' },
      { kind: 'file', path: join(tempDir, '.claude/rules/ktx.md'), role: 'rule' },
    ]);
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'codex', scope: 'project', mode: 'cli' })).toEqual([
      { kind: 'file', path: join(tempDir, '.agents/skills/ktx/SKILL.md'), role: 'skill' },
      { kind: 'file', path: join(tempDir, '.codex/instructions/ktx.md'), role: 'rule' },
    ]);
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'cursor', scope: 'project', mode: 'cli' })).toEqual([
      { kind: 'file', path: join(tempDir, '.cursor/rules/ktx.mdc') },
    ]);
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'opencode', scope: 'project', mode: 'cli' })).toEqual([
      { kind: 'file', path: join(tempDir, '.opencode/commands/ktx.md') },
    ]);
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'universal', scope: 'project', mode: 'cli' })).toEqual([
      { kind: 'file', path: join(tempDir, '.agents/skills/ktx/SKILL.md') },
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
    expect(skill).not.toContain('sql execute');
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
