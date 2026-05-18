import {
  createKtxSetupPromptAdapter,
  type KtxSetupPromptOption,
} from './setup-prompts.js';
import type { KtxSetupStatus } from './setup.js';

export type KtxSetupReadyAction =
  | 'models'
  | 'embeddings'
  | 'databases'
  | 'sources'
  | 'runtime'
  | 'context'
  | 'agents'
  | 'exit';

export interface KtxSetupReadyMenuPromptAdapter {
  select(options: { message: string; options: KtxSetupPromptOption[] }): Promise<string>;
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
    status.runtime.ready &&
    status.context.ready
  );
}

export function isKtxSetupReady(status: KtxSetupStatus): boolean {
  return isKtxPreAgentSetupReady(status) && status.agents.some((agent) => agent.ready);
}

function createPromptAdapter(): KtxSetupReadyMenuPromptAdapter {
  return createKtxSetupPromptAdapter({ selectCancelValue: 'exit' });
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
      { value: 'databases', label: 'Databases' },
      { value: 'sources', label: 'Context sources' },
      ...(status.runtime.required ? [{ value: 'runtime', label: 'Runtime' }] : []),
      { value: 'context', label: 'Rebuild KTX context' },
      { value: 'agents', label: 'Agent integration' },
      { value: 'exit', label: 'Exit' },
    ],
  })) as KtxSetupReadyAction;
  return { action };
}
