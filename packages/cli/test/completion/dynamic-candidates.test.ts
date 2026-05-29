import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProjectCompletionProviders } from '../../src/completion/dynamic-candidates.js';

const KTX_YAML = ['connections:', '  warehouse:', '    driver: sqlite', '  analytics:', '    driver: sqlite', ''].join(
  '\n',
);

describe('createProjectCompletionProviders', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'ktx-completion-'));
    await writeFile(join(projectDir, 'ktx.yaml'), KTX_YAML, 'utf-8');
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('completes connection ids for the `connection test` positional', async () => {
    const providers = createProjectCompletionProviders();
    const result = await providers.positionalCandidates(['connection', 'test'], ['--project-dir', projectDir]);
    expect(result).toEqual(['analytics', 'warehouse']);
  });

  it('completes connection ids for the `ingest` positional', async () => {
    const providers = createProjectCompletionProviders();
    const result = await providers.positionalCandidates(['ingest'], ['--project-dir', projectDir]);
    expect(result).toEqual(['analytics', 'warehouse']);
  });

  it('returns no positional candidates outside a project', async () => {
    const providers = createProjectCompletionProviders();
    const result = await providers.positionalCandidates(['connection', 'test'], ['--project-dir', join(projectDir, 'nope')]);
    expect(result).toEqual([]);
  });

  it('completes connection ids for the sql --connection option', async () => {
    const providers = createProjectCompletionProviders();
    const result = await providers.optionValueCandidates(['sql'], '--connection', ['--project-dir', projectDir]);
    expect(result).toEqual(['analytics', 'warehouse']);
  });

  it('still completes connection ids for the --connection-id option', async () => {
    const providers = createProjectCompletionProviders();
    const result = await providers.optionValueCandidates(['ingest'], '--connection-id', ['--project-dir', projectDir]);
    expect(result).toEqual(['analytics', 'warehouse']);
  });
});
