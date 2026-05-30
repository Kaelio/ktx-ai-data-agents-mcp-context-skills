import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

  async function seedProjectEntities(): Promise<void> {
    await mkdir(join(projectDir, 'semantic-layer', 'warehouse'), { recursive: true });
    await writeFile(
      join(projectDir, 'semantic-layer', 'warehouse', 'orders.yaml'),
      ['name: orders', 'table: public.orders', 'grain: [order_id]', 'columns: []', ''].join('\n'),
      'utf-8',
    );
    await mkdir(join(projectDir, 'semantic-layer', 'analytics'), { recursive: true });
    await writeFile(
      join(projectDir, 'semantic-layer', 'analytics', 'orders.yaml'),
      ['name: orders', 'table: public.analytics_orders', 'grain: [order_id]', 'columns: []', ''].join('\n'),
      'utf-8',
    );
    await writeFile(
      join(projectDir, 'semantic-layer', 'analytics', 'tickets.yaml'),
      ['name: tickets', 'table: public.tickets', 'grain: [ticket_id]', 'columns: []', ''].join('\n'),
      'utf-8',
    );
    await mkdir(join(projectDir, 'wiki', 'global'), { recursive: true });
    await writeFile(
      join(projectDir, 'wiki', 'global', 'revenue.md'),
      ['---', 'summary: Revenue', 'tags: []', 'refs: []', 'sl_refs: []', '---', '', 'Revenue rules.', ''].join('\n'),
      'utf-8',
    );
  }

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

  it('completes entity names only for read and validate subcommands', async () => {
    await seedProjectEntities();
    const providers = createProjectCompletionProviders();

    await expect(providers.positionalCandidates(['sl'], ['--project-dir', projectDir])).resolves.toEqual([]);
    await expect(providers.positionalCandidates(['sl', 'read'], ['--project-dir', projectDir])).resolves.toEqual([
      'orders',
      'tickets',
    ]);
    await expect(providers.positionalCandidates(['sl', 'validate'], ['--project-dir', projectDir])).resolves.toEqual([
      'orders',
      'tickets',
    ]);
    await expect(
      providers.positionalCandidates(['sl', 'read'], ['--project-dir', projectDir, '--connection-id', 'warehouse']),
    ).resolves.toEqual(['orders']);
    await expect(
      providers.positionalCandidates(['sl', 'validate'], ['--project-dir', projectDir, '--connection-id', 'analytics']),
    ).resolves.toEqual(['orders', 'tickets']);
    await expect(providers.positionalCandidates(['wiki'], ['--project-dir', projectDir])).resolves.toEqual([]);
    await expect(providers.positionalCandidates(['wiki', 'read'], ['--project-dir', projectDir])).resolves.toEqual([
      'revenue',
    ]);
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
