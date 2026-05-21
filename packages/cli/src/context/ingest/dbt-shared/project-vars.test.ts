import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadProjectInfo,
  parseProjectName,
  parseProjectVars,
  resolveJinjaVariables,
} from './project-vars.js';

function entries(map: Map<string, string>): Record<string, string> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

describe('dbt-shared project vars', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'dbt-project-vars-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('extracts top-level vars, nested dotted vars, and scalar values only', () => {
    const vars = parseProjectVars(`
name: revenue_project
vars:
  database: analytics
  enabled: true
  threads: 4
  ignored_list:
    - a
  ignored_null:
  pkg:
    region: us
    fiscal_year: 2026
`);

    expect(entries(vars)).toEqual({
      database: 'analytics',
      enabled: 'true',
      'pkg.fiscal_year': '2026',
      'pkg.region': 'us',
      threads: '4',
    });
  });

  it('returns an empty variable map for missing vars, malformed YAML, arrays, and scalar documents', () => {
    expect(entries(parseProjectVars('name: no_vars\n'))).toEqual({});
    expect(entries(parseProjectVars('{{{{ invalid yaml'))).toEqual({});
    expect(entries(parseProjectVars('- just\n- a\n- list\n'))).toEqual({});
  });

  it('extracts a string project name and returns null for invalid or missing names', () => {
    expect(parseProjectName('name: revenue_project\n')).toBe('revenue_project');
    expect(parseProjectName('version: 1\n')).toBeNull();
    expect(parseProjectName('{{{{ invalid yaml')).toBeNull();
    expect(parseProjectName('name: 42\n')).toBeNull();
  });

  it('resolves exact var names, honors defaults, and reports unresolved names without throwing', () => {
    const variables = new Map<string, string>([
      ['database', 'analytics'],
      ['pkg.region', 'us'],
    ]);

    const result = resolveJinjaVariables(
      [
        'database: "{{ var(\'database\') }}"',
        'region: "{{ var("pkg.region") }}"',
        'schema: "{{ var(\'schema\', \'public\') }}"',
        'missing: "{{ var(\'missing\') }}"',
      ].join('\n'),
      variables,
    );

    expect(result.content).toContain('database: "analytics"');
    expect(result.content).toContain('region: "us"');
    expect(result.content).toContain('schema: "public"');
    expect(result.content).toContain('missing: "{{ var(\'missing\') }}"');
    expect(result.unresolvedVars).toEqual(['missing']);
  });

  it('keeps package-scoped variables exact and does not resolve by suffix', () => {
    const variables = parseProjectVars(`
vars:
  pkg:
    database: package_db
`);

    const result = resolveJinjaVariables(
      'database: "{{ var(\'database\', \'fallback_db\') }}"\npackage_database: "{{ var(\'pkg.database\') }}"\n',
      variables,
    );

    expect(result.content).toContain('database: "fallback_db"');
    expect(result.content).toContain('package_database: "package_db"');
    expect(result.unresolvedVars).toEqual([]);
  });

  it('loads dbt_project.yml before dbt_project.yaml and falls back to an empty project info object', async () => {
    const projectDir = join(tmpRoot, 'project');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, 'dbt_project.yaml'), 'name: yaml_project\nvars:\n  database: yaml_db\n');
    await writeFile(join(projectDir, 'dbt_project.yml'), 'name: yml_project\nvars:\n  database: yml_db\n');

    const loaded = await loadProjectInfo(projectDir);
    expect(loaded.projectName).toBe('yml_project');
    expect(entries(loaded.variables)).toEqual({ database: 'yml_db' });

    const missing = await loadProjectInfo(join(tmpRoot, 'missing'));
    expect(missing.projectName).toBeNull();
    expect(entries(missing.variables)).toEqual({});
  });
});
