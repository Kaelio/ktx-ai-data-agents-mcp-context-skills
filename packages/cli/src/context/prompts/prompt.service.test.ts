import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PromptService } from './prompt.service.js';

describe('PromptService', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ktx-prompts-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads prompt files from the configured prompt directory', async () => {
    await writeFile(join(dir, 'hello.md'), 'Hello {{name}}', 'utf-8');
    const service = new PromptService({ promptsDir: dir, partials: [] });

    await expect(service.loadPrompt('hello')).resolves.toBe('Hello {{name}}');
  });

  it('loads prompts from additional directories when the primary directory misses', async () => {
    const extraDir = await mkdtemp(join(tmpdir(), 'ktx-prompts-extra-'));
    try {
      await writeFile(join(extraDir, 'memory_agent_research.md'), '<role>Packaged memory prompt</role>', 'utf-8');
      const service = new PromptService({ promptsDir: dir, additionalPromptDirs: [extraDir], partials: [] });

      await expect(service.loadPrompt('memory_agent_research')).resolves.toBe(
        '<role>Packaged memory prompt</role>',
      );
    } finally {
      await rm(extraDir, { recursive: true, force: true });
    }
  });

  it('formats prompts with default settings and context settings', async () => {
    await writeFile(join(dir, 'settings.md'), '{{settings.flag}} {{settings.mode}} {{name}}', 'utf-8');
    const service = new PromptService({
      promptsDir: dir,
      partials: [],
      defaultSettings: { flag: true, mode: 'default' },
    });

    const rendered = await service.formatPrompt('settings', {
      name: 'Ada',
      settings: { mode: 'override' },
    });

    expect(rendered).toBe('true override Ada');
  });
});
