import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

interface DbtProjectYaml {
  name?: unknown;
  vars?: unknown;
  [key: string]: unknown;
}

export interface DbtProjectInfo {
  variables: Map<string, string>;
  projectName: string | null;
}

export interface ResolveJinjaVariablesResult {
  content: string;
  unresolvedVars: string[];
}

/** @internal */
export function parseProjectVars(yamlContent: string): Map<string, string> {
  const variables = new Map<string, string>();
  const project = parseProjectYaml(yamlContent);

  if (!isRecord(project) || !isRecord(project.vars)) {
    return variables;
  }

  extractVariables(project.vars, '', variables);
  return variables;
}

/** @internal */
export function parseProjectName(yamlContent: string): string | null {
  const project = parseProjectYaml(yamlContent);

  if (!isRecord(project) || typeof project.name !== 'string') {
    return null;
  }

  return project.name;
}

export async function loadProjectInfo(projectDir: string): Promise<DbtProjectInfo> {
  for (const fileName of ['dbt_project.yml', 'dbt_project.yaml']) {
    const filePath = join(projectDir, fileName);
    try {
      const content = await readFile(filePath, 'utf-8');
      return {
        variables: parseProjectVars(content),
        projectName: parseProjectName(content),
      };
    } catch {
      // Try the next dbt project filename.
    }
  }

  return { variables: new Map(), projectName: null };
}

export function resolveJinjaVariables(
  content: string,
  variables: Map<string, string>,
): ResolveJinjaVariablesResult {
  const varPattern = /\{\{\s*var\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]*)['"]\s*)?\)\s*\}\}/g;
  const unresolvedVars = new Set<string>();

  const resolvedContent = content.replace(
    varPattern,
    (fullMatch, varName: string, defaultValue: string | undefined) => {
      const value = variables.get(varName);
      if (value !== undefined) {
        return value;
      }

      if (defaultValue !== undefined) {
        return defaultValue;
      }

      unresolvedVars.add(varName);
      return fullMatch;
    },
  );

  return {
    content: resolvedContent,
    unresolvedVars: [...unresolvedVars].sort(),
  };
}

function parseProjectYaml(yamlContent: string): DbtProjectYaml | null {
  try {
    const parsed = parseYaml(yamlContent) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractVariables(obj: Record<string, unknown>, prefix: string, variables: Map<string, string>): void {
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (value === null || value === undefined) {
      continue;
    }

    if (typeof value === 'string') {
      variables.set(fullKey, value);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      variables.set(fullKey, String(value));
    } else if (Array.isArray(value)) {
      continue;
    } else if (isRecord(value)) {
      extractVariables(value, fullKey, variables);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
