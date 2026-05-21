import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { type KtxLogger, noopLogger } from '../../../../context/core/config.js';
import { resolveJinjaVariables } from '../../dbt-shared/project-vars.js';

interface DbtParsedColumn {
  name: string;
  description: string | null;
  dataType: string | null;
  dataTests?: DbtDataTestRef[];
  constraints?: DbtColumnConstraints;
  enumValuesDbt?: string[];
}

interface DbtDataTestRef {
  name: string;
  package: string;
  kwargs?: Record<string, unknown>;
}

interface DbtColumnConstraints {
  dbt: {
    not_null?: boolean;
    unique?: boolean;
  };
}

interface DbtParsedRelationship {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  fromSchema?: string;
  toSchema?: string;
  description?: string;
}

interface DbtParsedTable {
  name: string;
  description: string | null;
  database: string | null;
  schema: string | null;
  columns: DbtParsedColumn[];
  resourceType?: 'source' | 'model';
  tagsDbt?: string[];
  freshnessDbt?: {
    raw?: unknown;
    loadedAtField?: string | null;
  };
}

export interface DbtSchemaParseResult {
  projectName: string | null;
  dbtVersion: string | null;
  tables: DbtParsedTable[];
  relationships: DbtParsedRelationship[];
}

export interface DbtSchemaFile {
  content: string;
  path: string;
}

interface ParseDbtSchemaOptions {
  path?: string;
  variables?: Map<string, string>;
  projectName?: string | null;
  logger?: KtxLogger;
}

interface DbtSchemaYaml {
  version?: number;
  sources?: DbtSchemaSource[];
  models?: DbtSchemaModel[];
}

interface DbtSchemaSource {
  name: string;
  description?: string;
  database?: string;
  schema?: string;
  tags?: string[];
  tables?: DbtSchemaTable[];
}

interface DbtSchemaTable {
  name: string;
  description?: string;
  identifier?: string;
  tags?: string[];
  loaded_at_field?: string;
  freshness?: unknown;
  columns?: DbtSchemaColumn[];
}

interface DbtSchemaModel {
  name: string;
  description?: string;
  database?: string;
  schema?: string;
  tags?: string[];
  loaded_at_field?: string;
  freshness?: unknown;
  columns?: DbtSchemaColumn[];
}

interface DbtSchemaColumn {
  name: string;
  description?: string;
  data_type?: string;
  data_tests?: DbtSchemaDataTest[];
  tests?: DbtSchemaDataTest[];
}

type DbtSchemaDataTest =
  | string
  | {
      relationships?: {
        to?: string;
        field?: string;
        arguments?: { to?: string; field?: string };
      };
      not_null?: unknown;
      unique?: unknown;
      accepted_values?: { values?: unknown } | unknown;
      [key: string]: unknown;
    };

/** @internal */
export function parseDbtSchemaFile(content: string, options: ParseDbtSchemaOptions = {}): DbtSchemaParseResult {
  return new DbtSchemaParser(options.logger ?? noopLogger).parseFile(content, options);
}

export function parseDbtSchemaFiles(
  files: DbtSchemaFile[],
  variables?: Map<string, string>,
  options: { projectName?: string | null; logger?: KtxLogger } = {},
): DbtSchemaParseResult {
  return new DbtSchemaParser(options.logger ?? noopLogger).parseFiles(files, variables, options.projectName ?? null);
}


class DbtSchemaParser {
  constructor(private readonly logger: KtxLogger) {}

  parseFile(yamlContent: string, options: ParseDbtSchemaOptions = {}): DbtSchemaParseResult {
    this.logger.debug(`Parsing schema file: ${options.path ?? 'unknown'}`);

    const resolved = options.variables
      ? resolveJinjaVariables(yamlContent, options.variables)
      : { content: yamlContent, unresolvedVars: [] };
    if (resolved.unresolvedVars.length > 0) {
      this.logger.warn(
        `Unresolved dbt variables in ${options.path ?? 'schema file'}: ${resolved.unresolvedVars.join(', ')}`,
      );
    }

    let schema: DbtSchemaYaml;
    try {
      schema = parseYaml(resolved.content) as DbtSchemaYaml;
    } catch (error) {
      this.logger.warn(`Failed to parse YAML${options.path ? ` at ${options.path}` : ''}: ${error}`);
      return this.emptyResult(options.projectName ?? null);
    }

    if (!schema || typeof schema !== 'object') {
      return this.emptyResult(options.projectName ?? null);
    }

    const tables = [...this.parseSources(schema.sources), ...this.parseModels(schema.models)];
    const relationships = [
      ...this.parseSourceRelationships(schema.sources),
      ...this.parseModelRelationships(schema.models),
    ];

    return {
      projectName: options.projectName ?? null,
      dbtVersion: null,
      tables,
      relationships,
    };
  }

  parseFiles(
    files: DbtSchemaFile[],
    variables?: Map<string, string>,
    projectName: string | null = null,
  ): DbtSchemaParseResult {
    const allTables: DbtParsedTable[] = [];
    const allRelationships: DbtParsedRelationship[] = [];

    for (const file of files) {
      const result = this.parseFile(file.content, { path: file.path, variables, projectName });
      allTables.push(...result.tables);
      allRelationships.push(...result.relationships);
    }

    return {
      projectName,
      dbtVersion: null,
      tables: this.deduplicateTables(allTables),
      relationships: this.deduplicateRelationships(allRelationships),
    };
  }

  private parseSources(sources: DbtSchemaSource[] | undefined): DbtParsedTable[] {
    if (!sources || !Array.isArray(sources)) {
      return [];
    }

    const tables: DbtParsedTable[] = [];

    for (const source of sources) {
      const sourceSchema = source.schema ?? source.name;
      const sourceDatabase = source.database ?? null;
      const sourceTags = this.normalizeTagList(source.tags);

      if (!source.tables || !Array.isArray(source.tables)) {
        continue;
      }

      for (const table of source.tables) {
        const tagsDbt = this.mergeTagsDbt(sourceTags, this.normalizeTagList(table.tags));
        const freshnessDbt = this.buildFreshnessDbt(table.freshness, table.loaded_at_field);
        tables.push({
          name: table.identifier ?? table.name,
          description: this.normalizeDescription(table.description),
          database: sourceDatabase,
          schema: sourceSchema,
          columns: this.parseColumns(table.columns),
          resourceType: 'source',
          ...(tagsDbt ? { tagsDbt } : {}),
          ...(freshnessDbt ? { freshnessDbt } : {}),
        });
      }
    }

    return tables;
  }

  private parseModels(models: DbtSchemaModel[] | undefined): DbtParsedTable[] {
    if (!models || !Array.isArray(models)) {
      return [];
    }

    const tables: DbtParsedTable[] = [];

    for (const model of models) {
      if (!model.name) {
        continue;
      }

      const tagsDbt = this.mergeTagsDbt(this.normalizeTagList(model.tags));
      const freshnessDbt = this.buildFreshnessDbt(model.freshness, model.loaded_at_field);
      tables.push({
        name: model.name,
        description: this.normalizeDescription(model.description),
        database: model.database ?? null,
        schema: model.schema ?? null,
        columns: this.parseColumns(model.columns),
        resourceType: 'model',
        ...(tagsDbt ? { tagsDbt } : {}),
        ...(freshnessDbt ? { freshnessDbt } : {}),
      });
    }

    return tables;
  }

  private parseColumns(columns: DbtSchemaColumn[] | undefined): DbtParsedColumn[] {
    if (!columns || !Array.isArray(columns)) {
      return [];
    }

    return columns.map((column) => {
      const { refs, constraints, enumValues } = this.parseDataTests(column.data_tests ?? column.tests);
      return {
        name: column.name,
        description: this.normalizeDescription(column.description),
        dataType: column.data_type ?? null,
        ...(refs.length > 0 ? { dataTests: refs } : {}),
        ...(constraints ? { constraints } : {}),
        ...(enumValues.length > 0 ? { enumValuesDbt: enumValues } : {}),
      };
    });
  }

  private parseDataTests(tests: DbtSchemaDataTest[] | undefined): {
    refs: DbtDataTestRef[];
    constraints: DbtColumnConstraints | undefined;
    enumValues: string[];
  } {
    const refs: DbtDataTestRef[] = [];
    const dbt: { not_null?: boolean; unique?: boolean } = {};
    const enumValues: string[] = [];
    if (!tests?.length) {
      return { refs, constraints: undefined, enumValues };
    }

    for (const test of tests) {
      if (typeof test === 'string') {
        const parsed = this.parseTestNameString(test);
        refs.push(parsed);
        if (parsed.package === 'dbt' && parsed.name === 'not_null') {
          dbt.not_null = true;
        }
        if (parsed.package === 'dbt' && parsed.name === 'unique') {
          dbt.unique = true;
        }
        continue;
      }

      for (const [key, value] of Object.entries(test)) {
        if (key === 'relationships') {
          refs.push({
            name: 'relationships',
            package: 'dbt',
            ...(value && typeof value === 'object' && !Array.isArray(value)
              ? { kwargs: value as Record<string, unknown> }
              : {}),
          });
          continue;
        }
        if (key === 'not_null') {
          refs.push({ name: 'not_null', package: 'dbt' });
          dbt.not_null = true;
          continue;
        }
        if (key === 'unique') {
          refs.push({ name: 'unique', package: 'dbt' });
          dbt.unique = true;
          continue;
        }
        if (key === 'accepted_values') {
          if (Array.isArray(value)) {
            enumValues.push(...value.map((item) => String(item)));
            refs.push({ name: 'accepted_values', package: 'dbt', kwargs: { values: value } });
            continue;
          }
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            const values = (value as { values?: unknown }).values;
            if (Array.isArray(values)) {
              enumValues.push(...values.map((item) => String(item)));
            }
            refs.push({ name: 'accepted_values', package: 'dbt', kwargs: value as Record<string, unknown> });
            continue;
          }
        }
        refs.push({
          ...this.parseTestNameString(key),
          ...(value && typeof value === 'object' && !Array.isArray(value)
            ? { kwargs: value as Record<string, unknown> }
            : {}),
        });
      }
    }

    const constraints = dbt.not_null || dbt.unique ? { dbt } : undefined;
    return { refs, constraints, enumValues };
  }

  private parseTestNameString(value: string): { name: string; package: string } {
    const parts = value.split('.');
    if (parts.length >= 2) {
      return { package: parts[0]!, name: parts.slice(1).join('.') };
    }
    return { package: 'dbt', name: value };
  }

  private parseSourceRelationships(sources: DbtSchemaSource[] | undefined): DbtParsedRelationship[] {
    if (!sources || !Array.isArray(sources)) {
      return [];
    }

    const relationships: DbtParsedRelationship[] = [];

    for (const source of sources) {
      const sourceSchema = source.schema ?? source.name;

      if (!source.tables || !Array.isArray(source.tables)) {
        continue;
      }

      for (const table of source.tables) {
        const tableName = table.identifier ?? table.name;

        if (!table.columns || !Array.isArray(table.columns)) {
          continue;
        }

        for (const column of table.columns) {
          const tests = column.data_tests ?? column.tests ?? [];

          for (const test of tests) {
            const relationship = this.parseRelationshipTest(test, tableName, column.name, sourceSchema);
            if (relationship) {
              relationships.push(relationship);
            }
          }
        }
      }
    }

    return relationships;
  }

  private parseModelRelationships(models: DbtSchemaModel[] | undefined): DbtParsedRelationship[] {
    if (!models || !Array.isArray(models)) {
      return [];
    }

    const relationships: DbtParsedRelationship[] = [];

    for (const model of models) {
      if (!model.name || !model.columns || !Array.isArray(model.columns)) {
        continue;
      }

      for (const column of model.columns) {
        const tests = column.data_tests ?? column.tests ?? [];

        for (const test of tests) {
          const relationship = this.parseRelationshipTest(test, model.name, column.name, model.schema ?? undefined);
          if (relationship) {
            relationships.push(relationship);
          }
        }
      }
    }

    return relationships;
  }

  private parseRelationshipTest(
    test: DbtSchemaDataTest,
    fromTable: string,
    fromColumn: string,
    fromSchema?: string,
  ): DbtParsedRelationship | null {
    if (typeof test === 'string' || !test.relationships) {
      return null;
    }

    const relationship = test.relationships;
    const toRef = relationship.to ?? relationship.arguments?.to;
    const toColumn = relationship.field ?? relationship.arguments?.field;

    if (!toRef || !toColumn) {
      this.logger.debug(`Skipping incomplete relationship test for ${fromTable}.${fromColumn}`);
      return null;
    }

    const toTable = this.parseRef(toRef);
    if (!toTable) {
      this.logger.debug(`Could not parse ref: ${toRef}`);
      return null;
    }

    return {
      fromTable,
      fromColumn,
      toTable,
      toColumn,
      ...(fromSchema ? { fromSchema } : {}),
    };
  }

  private parseRef(refString: string): string | null {
    const refMatch = refString.match(/ref\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (refMatch) {
      return refMatch[1];
    }

    const sourceMatch = refString.match(/source\s*\(\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
    if (sourceMatch) {
      return sourceMatch[1];
    }

    return null;
  }

  private normalizeDescription(description: string | undefined): string | null {
    if (!description) {
      return null;
    }
    const trimmed = description.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private normalizeTagList(tags: string[] | undefined): string[] {
    if (!tags || !Array.isArray(tags)) {
      return [];
    }
    return tags.map((tag) => String(tag));
  }

  private mergeTagsDbt(...lists: Array<string[] | undefined>): string[] | undefined {
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const list of lists) {
      for (const item of list ?? []) {
        if (!seen.has(item)) {
          seen.add(item);
          merged.push(item);
        }
      }
    }
    return merged.length > 0 ? merged : undefined;
  }

  private buildFreshnessDbt(freshness: unknown, loadedAtField: string | undefined): DbtParsedTable['freshnessDbt'] {
    const loadedTrim = loadedAtField?.trim();
    const hasFreshness = freshness !== undefined && freshness !== null;
    if (!hasFreshness && !loadedTrim) {
      return undefined;
    }
    return {
      ...(hasFreshness ? { raw: freshness } : {}),
      ...(hasFreshness ? { loadedAtField: loadedTrim ?? null } : loadedTrim ? { loadedAtField: loadedTrim } : {}),
    };
  }

  private deduplicateTables(tables: DbtParsedTable[]): DbtParsedTable[] {
    const seen = new Map<string, DbtParsedTable>();

    for (const table of tables) {
      const key = `${table.database ?? ''}.${table.schema ?? ''}.${table.name}`.toLowerCase();
      const existing = seen.get(key);

      if (!existing) {
        seen.set(key, table);
        continue;
      }

      seen.set(key, {
        ...existing,
        description: existing.description ?? table.description,
        columns: this.mergeColumns(existing.columns, table.columns),
        tagsDbt: this.mergeTagsDbt(existing.tagsDbt, table.tagsDbt),
        freshnessDbt: this.mergeFreshnessDbt(existing.freshnessDbt, table.freshnessDbt),
      });
    }

    return Array.from(seen.values());
  }

  private mergeColumns(existing: DbtParsedColumn[], incoming: DbtParsedColumn[]): DbtParsedColumn[] {
    const seen = new Map<string, DbtParsedColumn>();

    for (const column of existing) {
      seen.set(column.name.toLowerCase(), column);
    }

    for (const column of incoming) {
      const key = column.name.toLowerCase();
      const existingColumn = seen.get(key);

      if (!existingColumn) {
        seen.set(key, column);
        continue;
      }

      seen.set(key, {
        ...existingColumn,
        description: existingColumn.description ?? column.description,
        dataType: existingColumn.dataType ?? column.dataType,
        dataTests: this.mergeDbtDataTests(existingColumn.dataTests, column.dataTests),
        constraints: this.mergeDbtConstraints(existingColumn.constraints, column.constraints),
        enumValuesDbt: this.mergeStringList(existingColumn.enumValuesDbt, column.enumValuesDbt),
      });
    }

    return Array.from(seen.values());
  }

  private deduplicateRelationships(relationships: DbtParsedRelationship[]): DbtParsedRelationship[] {
    const seen = new Set<string>();
    const result: DbtParsedRelationship[] = [];

    for (const relationship of relationships) {
      const key =
        `${relationship.fromTable}.${relationship.fromColumn}->${relationship.toTable}.${relationship.toColumn}`.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push(relationship);
      }
    }

    return result;
  }

  private mergeFreshnessDbt(
    existing?: DbtParsedTable['freshnessDbt'],
    incoming?: DbtParsedTable['freshnessDbt'],
  ): DbtParsedTable['freshnessDbt'] {
    if (!existing && !incoming) {
      return undefined;
    }
    const raw = existing?.raw !== undefined ? existing.raw : incoming?.raw;
    const loadedAtField = existing?.loadedAtField ?? incoming?.loadedAtField;
    return {
      ...(raw !== undefined ? { raw } : {}),
      ...(loadedAtField !== undefined ? { loadedAtField } : {}),
    };
  }

  private mergeDbtConstraints(
    existing?: DbtColumnConstraints,
    incoming?: DbtColumnConstraints,
  ): DbtColumnConstraints | undefined {
    const notNull = !!(existing?.dbt.not_null || incoming?.dbt.not_null);
    const unique = !!(existing?.dbt.unique || incoming?.dbt.unique);
    if (!notNull && !unique) {
      return undefined;
    }
    return { dbt: { ...(notNull ? { not_null: true } : {}), ...(unique ? { unique: true } : {}) } };
  }

  private mergeStringList(existing?: string[], incoming?: string[]): string[] | undefined {
    return this.mergeTagsDbt(existing, incoming);
  }

  private mergeDbtDataTests(existing?: DbtDataTestRef[], incoming?: DbtDataTestRef[]): DbtDataTestRef[] | undefined {
    if (!existing?.length) {
      return incoming?.length ? [...incoming] : undefined;
    }
    if (!incoming?.length) {
      return [...existing];
    }
    const tests = new Map<string, DbtDataTestRef>();
    for (const test of [...existing, ...incoming]) {
      const kwargsKey =
        test.kwargs && Object.keys(test.kwargs).length > 0
          ? `:${createHash('sha256').update(JSON.stringify(test.kwargs)).digest('hex').slice(0, 16)}`
          : '';
      tests.set(`${test.package}:${test.name}${kwargsKey}`, test);
    }
    return [...tests.values()];
  }

  private emptyResult(projectName: string | null): DbtSchemaParseResult {
    return {
      projectName,
      dbtVersion: null,
      tables: [],
      relationships: [],
    };
  }
}
