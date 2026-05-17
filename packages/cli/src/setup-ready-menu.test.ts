import { describe, expect, it, vi } from 'vitest';
import { isKtxPreAgentSetupReady, isKtxSetupReady, runKtxSetupReadyChangeMenu } from './setup-ready-menu.js';
import type { KtxSetupStatus } from './setup.js';

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

describe('setup ready menu', () => {
  it('recognizes a ready setup only when required sections are ready', () => {
    expect(isKtxSetupReady(readyStatus)).toBe(true);
    expect(isKtxSetupReady({ ...readyStatus, embeddings: { ready: false } })).toBe(false);
    expect(isKtxSetupReady({ ...readyStatus, runtime: { required: true, ready: false, features: ['core'] } })).toBe(false);
    expect(isKtxSetupReady({ ...readyStatus, context: { ready: false, status: 'not_started' } })).toBe(false);
    expect(isKtxSetupReady({ ...readyStatus, agents: [] })).toBe(false);
  });

  it('recognizes pre-agent readiness without requiring agents', () => {
    expect(isKtxPreAgentSetupReady(readyStatus)).toBe(true);
    expect(isKtxPreAgentSetupReady({ ...readyStatus, agents: [] })).toBe(true);
    expect(isKtxPreAgentSetupReady({ ...readyStatus, embeddings: { ready: false } })).toBe(false);
    expect(isKtxPreAgentSetupReady({ ...readyStatus, runtime: { required: true, ready: false, features: ['core'] } })).toBe(
      false,
    );
    expect(isKtxPreAgentSetupReady({ ...readyStatus, context: { ready: false, status: 'not_started' } })).toBe(false);
  });

  it('maps ready-project menu choices to setup sections', async () => {
    const prompts = { select: vi.fn(async () => 'agents'), cancel: vi.fn() };

    await expect(runKtxSetupReadyChangeMenu(readyStatus, { prompts })).resolves.toEqual({ action: 'agents' });

    expect(prompts.select).toHaveBeenCalledWith({
      message: 'KTX is already set up for /tmp/revenue. What would you like to change?',
      options: [
        { value: 'models', label: 'Models' },
        { value: 'embeddings', label: 'Embeddings' },
        { value: 'databases', label: 'Databases' },
        { value: 'sources', label: 'Context sources' },
        { value: 'context', label: 'Rebuild KTX context' },
        { value: 'agents', label: 'Agent integration' },
        { value: 'exit', label: 'Exit' },
      ],
    });
  });
});
