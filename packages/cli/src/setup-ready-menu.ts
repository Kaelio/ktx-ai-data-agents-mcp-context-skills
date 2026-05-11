import { cancel, isCancel, select } from '@clack/prompts';
import { withMenuOptionsSpacing } from './prompt-navigation.js';
import type { KtxSetupStatus } from './setup.js';
import { withSetupInterruptConfirmation } from './setup-interrupt.js';

export type KtxSetupReadyAction = 'models' | 'embeddings' | 'databases' | 'sources' | 'context' | 'agents' | 'exit';

export interface KtxSetupReadyMenuPromptAdapter {
  select(options: { message: string; options: Array<{ value: string; label: string }> }): Promise<string>;
  cancel(message: string): void;
}

export interface KtxSetupReadyMenuDeps {
  prompts?: KtxSetupReadyMenuPromptAdapter;
}

export function isKtxPreAgentSetupReady(status: KtxSetupStatus): boolean {
  return (
    status.project.ready &&
    status.llm.ready &&
    status.embeddings.ready &&
    status.databases.every((database) => database.ready) &&
    status.sources.every((source) => source.ready) &&
    status.context.ready
  );
}

export function isKtxSetupReady(status: KtxSetupStatus): boolean {
  return isKtxPreAgentSetupReady(status) && status.agents.some((agent) => agent.ready);
}

function createPromptAdapter(): KtxSetupReadyMenuPromptAdapter {
  return {
    async select(options) {
      const value = await withSetupInterruptConfirmation(() => select(withMenuOptionsSpacing(options)));
      if (isCancel(value)) {
        cancel('Setup cancelled.');
        return 'exit';
      }
      return String(value);
    },
    cancel(message) {
      cancel(message);
    },
  };
}

export async function runKtxSetupReadyChangeMenu(
  status: KtxSetupStatus,
  deps: KtxSetupReadyMenuDeps = {},
): Promise<{ action: KtxSetupReadyAction }> {
  const prompts = deps.prompts ?? createPromptAdapter();
  const action = (await prompts.select({
    message: `KTX is already set up for ${status.project.name ?? status.project.path}. What would you like to change?`,
    options: [
      { value: 'models', label: 'Models' },
      { value: 'embeddings', label: 'Embeddings' },
      { value: 'databases', label: 'Primary sources' },
      { value: 'sources', label: 'Context sources' },
      { value: 'context', label: 'Rebuild KTX context' },
      { value: 'agents', label: 'Agent integration' },
      { value: 'exit', label: 'Exit' },
    ],
  })) as KtxSetupReadyAction;
  return { action };
}
