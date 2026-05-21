import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import type { DbtSchemaFile } from '../adapters/dbt-descriptions/parse-schema.js';

const DBT_SCHEMA_SEARCH_DIRS = ['models', 'seeds', 'snapshots', 'analyses', '.'] as const;
const DBT_CONFIG_YAML_FILES = new Set([
  'dbt_project.yml',
  'dbt_project.yaml',
  'packages.yml',
  'packages.yaml',
  'selectors.yml',
  'selectors.yaml',
]);

export async function loadDbtSchemaFiles(projectDir: string): Promise<DbtSchemaFile[]> {
  const schemaFiles = await findDbtSchemaFiles(projectDir);
  return Promise.all(
    schemaFiles.map(async (filePath) => ({
      content: await fs.readFile(filePath, 'utf-8'),
      path: relative(projectDir, filePath),
    })),
  );
}

export async function findDbtSchemaFiles(projectDir: string): Promise<string[]> {
  const schemaFiles: string[] = [];

  for (const dir of DBT_SCHEMA_SEARCH_DIRS) {
    const searchPath = join(projectDir, dir);
    try {
      await fs.access(searchPath);
      schemaFiles.push(...(await findYamlFilesRecursive(searchPath)));
    } catch {
      // Missing dbt search directories are normal.
    }
  }

  return [...new Set(schemaFiles)].sort();
}

async function findYamlFilesRecursive(dir: string): Promise<string[]> {
  const files: string[] = [];

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
        files.push(...(await findYamlFilesRecursive(fullPath)));
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const name = entry.name.toLowerCase();
    if (DBT_CONFIG_YAML_FILES.has(name)) {
      continue;
    }

    if (name.endsWith('.yml') || name.endsWith('.yaml')) {
      files.push(fullPath);
    }
  }

  return files;
}
