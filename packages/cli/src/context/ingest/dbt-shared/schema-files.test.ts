import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findDbtSchemaFiles, loadDbtSchemaFiles } from './schema-files.js';

describe('dbt shared schema files', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'dbt-schema-files-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('loads schema yaml files from dbt search directories and skips project config files', async () => {
    await mkdir(join(tmpRoot, 'models', 'nested'), { recursive: true });
    await mkdir(join(tmpRoot, 'seeds'), { recursive: true });
    await writeFile(join(tmpRoot, 'dbt_project.yml'), 'name: ignored\n');
    await writeFile(join(tmpRoot, 'packages.yml'), 'packages: []\n');
    await writeFile(join(tmpRoot, 'models', 'schema.yml'), 'version: 2\nmodels: []\n');
    await writeFile(join(tmpRoot, 'models', 'nested', 'customers.yaml'), 'version: 2\nmodels: []\n');
    await writeFile(join(tmpRoot, 'seeds', 'seed.yml'), 'version: 2\nseeds: []\n');

    const paths = await findDbtSchemaFiles(tmpRoot);
    expect(paths.map((path) => path.replace(`${tmpRoot}/`, '')).sort()).toEqual([
      'models/nested/customers.yaml',
      'models/schema.yml',
      'seeds/seed.yml',
    ]);

    const files = await loadDbtSchemaFiles(tmpRoot);
    expect(files.map((file) => file.path).sort()).toEqual([
      'models/nested/customers.yaml',
      'models/schema.yml',
      'seeds/seed.yml',
    ]);
  });
});
