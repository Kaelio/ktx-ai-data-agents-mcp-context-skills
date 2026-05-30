import type { Command } from '@commander-js/extra-typings';
import { describe, expect, it } from 'vitest';
import { buildKtxProgram } from '../../src/cli-program.js';
import type { KtxCliIo, KtxCliPackageInfo } from '../../src/cli-runtime.js';
import { type CompletionProviders, computeCompletions } from '../../src/completion/complete-engine.js';

function stubIo(): KtxCliIo {
  return { stdout: { isTTY: false, columns: 80, write: () => {} }, stderr: { write: () => {} } };
}

function stubPackageInfo(): KtxCliPackageInfo {
  return { name: '@kaelio/ktx', version: '0.0.0-test' };
}

function buildProgram(): Command {
  return buildKtxProgram({ io: stubIo(), deps: {}, packageInfo: stubPackageInfo(), runInit: async () => 0 });
}

const SOURCES = ['orders', 'customers'];
const WIKI_KEYS = ['revenue', 'churn'];
const CONNECTIONS = ['warehouse'];

function fakeProviders(overrides: Partial<CompletionProviders> = {}): CompletionProviders {
  return {
    async positionalCandidates(commandPath) {
      const key = commandPath.join(' ');
      if (key === 'sl' || key === 'sl validate') {
        return SOURCES;
      }
      if (key === 'wiki') {
        return WIKI_KEYS;
      }
      return [];
    },
    async optionValueCandidates(_commandPath, optionFlag) {
      return optionFlag === '--connection-id' ? CONNECTIONS : [];
    },
    ...overrides,
  };
}

function complete(words: string[], providers: CompletionProviders = fakeProviders()): Promise<string[]> {
  return computeCompletions(buildProgram(), words, providers);
}

describe('computeCompletions', () => {
  it('lists top-level commands and hides internal ones', async () => {
    const result = await complete(['']);
    expect(result).toContain('sl');
    expect(result).toContain('wiki');
    expect(result).toContain('completion');
    expect(result).not.toContain('__complete');
  });

  it('filters top-level commands by prefix', async () => {
    expect(await complete(['co'])).toEqual(['completion', 'connection']);
  });

  it('hides Commander-hidden subcommands such as `mcp serve-internal`', async () => {
    const result = await complete(['mcp', '']);
    expect(result).not.toContain('serve-internal');
    expect(result).toEqual(['logs', 'start', 'status', 'stdio', 'stop']);
  });

  it('offers sl subcommands and source names together, sorted and deduped', async () => {
    expect(await complete(['sl', ''])).toEqual(['customers', 'orders', 'query', 'validate']);
  });

  it('offers only source names for sl validate', async () => {
    expect(await complete(['sl', 'validate', ''])).toEqual(['customers', 'orders']);
  });

  it('offers wiki page keys', async () => {
    expect(await complete(['wiki', ''])).toEqual(['churn', 'revenue']);
  });

  it('filters positional candidates by prefix', async () => {
    expect(await complete(['sl', 'o'])).toEqual(['orders']);
  });

  it('completes flags (own + inherited globals) when the partial starts with a dash', async () => {
    const result = await complete(['sl', '-']);
    expect(result).toContain('--connection-id');
    expect(result).toContain('--output');
    expect(result).toContain('--json');
    expect(result).toContain('--debug');
    expect(result).toContain('--project-dir');
  });

  it('completes option choices for the `--opt value` form', async () => {
    expect(await complete(['sl', '--output', ''])).toEqual(['json', 'plain', 'pretty']);
  });

  it('completes option choices for the `--opt=value` form', async () => {
    expect(await complete(['sl', '--output=pr'])).toEqual(['--output=pretty']);
  });

  it('completes option values from a provider for options without static choices', async () => {
    expect(await complete(['sl', '--connection-id', ''])).toEqual(['warehouse']);
  });

  it('falls through to positional completion after a boolean flag', async () => {
    const result = await complete(['sl', '--json', '']);
    expect(result).toContain('orders');
    expect(result).toContain('validate');
  });

  it('still returns subcommands/flags when dynamic providers yield nothing (no project)', async () => {
    const empty = fakeProviders({
      positionalCandidates: async () => [],
      optionValueCandidates: async () => [],
    });
    expect(await complete(['sl', ''], empty)).toEqual(['query', 'validate']);
    expect(await complete(['-'], empty)).toContain('--debug');
  });

  it('completes the completion command shell positional from its static choices', async () => {
    expect(await complete(['completion', ''])).toEqual(['bash', 'zsh']);
  });

  it('filters positional argument choices by prefix', async () => {
    expect(await complete(['completion', 'z'])).toEqual(['zsh']);
  });
});
