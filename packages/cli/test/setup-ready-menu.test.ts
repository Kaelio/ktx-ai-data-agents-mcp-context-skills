import { describe, expect, it, vi } from 'vitest';
import {
  classifyKtxSetupCompletion,
  runKtxSetupReadyChangeMenu,
  runKtxSetupReadyMenu,
} from '../src/setup-ready-menu.js';
import type { KtxSetupStatus } from '../src/setup.js';

const readyStatus: KtxSetupStatus = {
  project: { path: '/tmp/revenue', ready: true },
  llm: { backend: 'anthropic', ready: true, model: 'claude-sonnet-4-6' },
  embeddings: { backend: 'openai', ready: true, model: 'text-embedding-3-small', dimensions: 1536 },
  databases: [{ connectionId: 'warehouse', ready: true }],
  sources: [],
  runtime: { required: false, ready: true, features: [] },
  context: { ready: true, status: 'completed' },
  agents: [{ target: 'codex', scope: 'project', ready: true }],
};

describe('classifyKtxSetupCompletion', () => {
  it('reports ready only when config, context, and agents are all ready', () => {
    expect(classifyKtxSetupCompletion(readyStatus)).toBe('ready');
  });

  it('reports needs-agents when config and context are ready but no agent is installed', () => {
    expect(classifyKtxSetupCompletion({ ...readyStatus, agents: [] })).toBe('needs-agents');
  });

  it('reports needs-context when config is ready but context is not built', () => {
    expect(
      classifyKtxSetupCompletion({ ...readyStatus, context: { ready: false, status: 'not_started' } }),
    ).toBe('needs-context');
  });

  it('reports incomplete when a required config section is not ready', () => {
    expect(classifyKtxSetupCompletion({ ...readyStatus, embeddings: { ready: false } })).toBe('incomplete');
    expect(
      classifyKtxSetupCompletion({ ...readyStatus, runtime: { required: true, ready: false, features: ['core'] } }),
    ).toBe('incomplete');
  });

  it('reports incomplete when no context targets are configured', () => {
    expect(classifyKtxSetupCompletion({ ...readyStatus, databases: [], sources: [] })).toBe('incomplete');
  });
});

describe('runKtxSetupReadyMenu', () => {
  it('exits when the user is done', async () => {
    const prompts = { select: vi.fn(async () => 'done'), cancel: vi.fn() };

    await expect(runKtxSetupReadyMenu(readyStatus, { prompts })).resolves.toEqual({ action: 'exit' });

    expect(prompts.select).toHaveBeenCalledTimes(1);
    expect(prompts.select).toHaveBeenCalledWith({
      message: 'Anything else?',
      options: [
        { value: 'done', label: "Done — I'll start using ktx" },
        { value: 'change', label: 'Change a setting' },
      ],
    });
  });

  it('opens the section menu when the user chooses to change a setting', async () => {
    const select = vi.fn().mockResolvedValueOnce('change').mockResolvedValueOnce('models');
    const prompts = { select, cancel: vi.fn() };

    await expect(runKtxSetupReadyMenu(readyStatus, { prompts })).resolves.toEqual({ action: 'models' });

    expect(select).toHaveBeenCalledTimes(2);
    expect(select).toHaveBeenLastCalledWith({
      message: 'What would you like to change?',
      options: [
        { value: 'models', label: 'Models' },
        { value: 'embeddings', label: 'Embeddings' },
        { value: 'databases', label: 'Databases' },
        { value: 'sources', label: 'Context sources' },
        { value: 'context', label: 'Rebuild ktx context' },
        { value: 'agents', label: 'Agent integration' },
        { value: 'exit', label: 'Exit' },
      ],
    });
  });
});

describe('runKtxSetupReadyChangeMenu', () => {
  it('maps ready-project menu choices to setup sections', async () => {
    const prompts = { select: vi.fn(async () => 'agents'), cancel: vi.fn() };

    await expect(runKtxSetupReadyChangeMenu(readyStatus, { prompts })).resolves.toEqual({ action: 'agents' });

    expect(prompts.select).toHaveBeenCalledWith({
      message: 'What would you like to change?',
      options: [
        { value: 'models', label: 'Models' },
        { value: 'embeddings', label: 'Embeddings' },
        { value: 'databases', label: 'Databases' },
        { value: 'sources', label: 'Context sources' },
        { value: 'context', label: 'Rebuild ktx context' },
        { value: 'agents', label: 'Agent integration' },
        { value: 'exit', label: 'Exit' },
      ],
    });
  });

  it('includes the runtime option only when the runtime is required', async () => {
    const prompts = { select: vi.fn(async () => 'runtime'), cancel: vi.fn() };

    await runKtxSetupReadyChangeMenu(
      { ...readyStatus, runtime: { required: true, ready: true, features: ['core'] } },
      { prompts },
    );

    expect(prompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([{ value: 'runtime', label: 'Runtime' }]),
      }),
    );
  });
});
