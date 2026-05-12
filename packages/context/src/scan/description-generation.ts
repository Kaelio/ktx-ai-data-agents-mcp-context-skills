import type { KtxLlmProvider } from '@ktx/llm';
import { generateKtxText } from '../llm/index.js';
import type {
  KtxColumnSampleInput,
  KtxColumnSampleResult,
  KtxScanContext,
  KtxScanLoggerPort,
  KtxTableRef,
  KtxTableSampleInput,
  KtxTableSampleResult,
} from './types.js';

export interface KtxDescriptionCachePort {
  buildTableKey(table: KtxTableRef): string;
  buildColumnKey(table: KtxTableRef, columnName: string): string;
  buildConnectionKey(connectionName: string): string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface KtxDescriptionSamplingPort {
  id: string;
  sampleColumn?(input: KtxColumnSampleInput, ctx: KtxScanContext): Promise<KtxColumnSampleResult>;
  sampleTable?(input: KtxTableSampleInput, ctx: KtxScanContext): Promise<KtxTableSampleResult>;
}

export interface KtxDescriptionGenerationSettings {
  columnMaxWords: number;
  tableMaxWords: number;
  dataSourceMaxWords: number;
  temperature?: number;
  concurrencyLimit?: number;
}

interface ResolvedKtxDescriptionGenerationSettings {
  columnMaxWords: number;
  tableMaxWords: number;
  dataSourceMaxWords: number;
  temperature?: number;
  concurrencyLimit: number;
}

export interface KtxDescriptionColumn {
  name: string;
  type?: string;
  rawDescriptions?: Record<string, string>;
  sampleValues?: unknown[];
}

export interface KtxDescriptionColumnTable extends KtxTableRef {
  columns: KtxDescriptionColumn[];
}

export interface KtxDescriptionTableInput extends KtxTableRef {
  rawDescriptions?: Record<string, string>;
}

export interface KtxColumnAnalysisResult {
  columnDescriptions: Array<[string, string | null]>;
  processedColumns: string[];
  skippedColumns: string[];
}

export interface KtxColumnDescriptionPromptInput {
  columnName: string;
  columnValues: unknown[];
  tableContext: string;
  dataSourceType: string;
  supportsNestedAnalysis: boolean;
  rawDescriptions?: Record<string, string>;
}

export interface KtxTableDescriptionPromptInput {
  tableName: string;
  sampleData: KtxTableSampleResult;
  dataSourceType: string;
  rawDescriptions?: Record<string, string>;
}

export interface KtxDataSourceDescriptionPromptInput {
  tableSamples: Array<[string, KtxTableSampleResult]>;
  dataSourceType: string;
}

export interface KtxGenerateColumnDescriptionsInput {
  connectionId: string;
  connector: KtxDescriptionSamplingPort;
  context: KtxScanContext;
  dataSourceType: string;
  supportsNestedAnalysis: boolean;
  table: KtxDescriptionColumnTable;
  skipExisting?: boolean;
  existingDescriptions?: Record<string, string | null>;
}

export interface KtxGenerateTableDescriptionInput {
  connectionId: string;
  connector: KtxDescriptionSamplingPort;
  context: KtxScanContext;
  dataSourceType: string;
  table: KtxDescriptionTableInput;
}

export interface KtxGenerateDataSourceDescriptionInput {
  connectionId: string;
  connector: KtxDescriptionSamplingPort;
  context: KtxScanContext;
  dataSourceType: string;
  tables: KtxTableRef[];
  connectionName?: string;
}

export interface KtxDescriptionGeneratorOptions {
  llmProvider: KtxLlmProvider;
  cache?: KtxDescriptionCachePort;
  logger?: KtxScanLoggerPort;
  settings: KtxDescriptionGenerationSettings;
}

interface ColumnTaskResult {
  columnName: string;
  description: string | null;
  processed: boolean;
  skipped: boolean;
}

function descriptionSources(rawDescriptions: Record<string, string> | undefined): Array<[string, string]> {
  if (!rawDescriptions) {
    return [];
  }

  return Object.entries(rawDescriptions).filter(([source, text]) => source !== 'ai' && source !== 'user' && !!text);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toTableRef(table: KtxTableRef): KtxTableRef {
  return {
    catalog: table.catalog,
    db: table.db,
    name: table.name,
  };
}

async function runWithConcurrency<TInput, TOutput>(
  items: readonly TInput[],
  concurrencyLimit: number,
  worker: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  const results: TOutput[] = [];
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrencyLimit, items.length || 1));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        const item = items[index];
        if (item !== undefined) {
          results[index] = await worker(item, index);
        }
      }
    }),
  );

  return results;
}

export function appendKtxWordLimitInstruction(prompt: string, maxWords: number): string {
  return `${prompt}\n\nPlease provide a concise description in ${maxWords} words or less.`;
}

export function buildKtxColumnDescriptionPrompt(input: KtxColumnDescriptionPromptInput): string {
  const sampleValues = input.columnValues.slice(0, 5);
  const valuesStr = sampleValues
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value))
    .join(', ');

  let prompt = `Analyze this database column and provide a concise description:

<table_context> ${input.tableContext} </table_context>

<column_name> ${input.columnName} </column_name>

<sample_values> ${valuesStr} </sample_values>
`;

  const sources = descriptionSources(input.rawDescriptions);
  if (sources.length > 0) {
    prompt += '\nExisting descriptions from other sources:\n';
    for (const [source, text] of sources) {
      prompt += `<${source}_documentation> ${text} </${source}_documentation>\n`;
    }
    prompt +=
      '\nSynthesize a description that captures the most important information from all sources. Prioritize the sources as authoritative context.\n';
  }

  prompt += `
Provide a brief description of what this column contains without repeating the column name.
Focus on the data's meaning and business purpose. Start directly with the content description.
Example:
"first names of individuals, likely employees or contacts" instead of "The column contains first names..."
"Job titles or roles of individuals..." instead of "This column contains job titles..."
`;

  if (input.dataSourceType === 'BIGQUERY' && input.supportsNestedAnalysis) {
    const hasNestedData = sampleValues.some((value) => {
      const text = String(value);
      return text.includes('nested') || text.includes('{') || text.includes('[');
    });
    if (hasNestedData) {
      prompt +=
        '\nNote: This column contains nested/structured data (JSON, STRUCT, or ARRAY) - describe its general business purpose and data organization.';
    }
  }

  return prompt.trim();
}

export function buildKtxTableDescriptionPrompt(input: KtxTableDescriptionPromptInput): string {
  const columnInfo: string[] = [];
  for (let index = 0; index < Math.min(input.sampleData.headers.length, 10); index += 1) {
    const header = input.sampleData.headers[index];
    const sampleValues = input.sampleData.rows
      .slice(0, 3)
      .map((row) => row[index])
      .filter((value) => value !== null && value !== undefined);
    columnInfo.push(`${header}: ${sampleValues.map((value) => String(value)).join(', ')}`);
  }

  let prompt = `
        Analyze this database table and provide a concise description:

        Table: ${input.tableName}
        Columns and sample data: ${columnInfo.join(' | ')}
        Total rows in sample: ${input.sampleData.rows.length}
        Data source type: ${input.dataSourceType}
        `;

  const sources = descriptionSources(input.rawDescriptions);
  if (sources.length > 0) {
    prompt += '\n        Existing descriptions from other sources:\n';
    for (const [source, text] of sources) {
      prompt += `        ${source}: ${text}\n`;
    }
    prompt +=
      '\n        Synthesize a description that captures the most important information from all sources. Prioritize the sources as authoritative context.\n';
  }

  if (input.dataSourceType === 'BIGQUERY') {
    prompt +=
      "\nNote (Don't include this note in the final answer.): This is a BigQuery table which may contain nested structures, arrays, or other complex data types.";
  }

  prompt += `

        Provide a brief description of what this table represents and its business purpose.
        Do NOT list or describe individual columns or fields.
        Start directly with the content description without mentioning the table name.
        Focus on the data's meaning and business purpose.
        Example: "Information about healthcare professionals used for workforce management" instead of "The blahblah table contains information about healthcare professionals including their names, titles..."
        `;

  return prompt.trim();
}

export function buildKtxDataSourceDescriptionPrompt(input: KtxDataSourceDescriptionPromptInput): string {
  const tablesText = input.tableSamples
    .map(
      ([tableName, sampleData]) =>
        `${tableName} (${sampleData.headers.length} columns, ${sampleData.rows.length} sample rows)`,
    )
    .join(' | ');

  let prompt = `
        Analyze this database and provide a concise description:

        Tables: ${tablesText}
        Total tables analyzed: ${input.tableSamples.length}
        Data source type: ${input.dataSourceType}
        `;

  if (input.dataSourceType === 'BIGQUERY') {
    prompt +=
      "\nNote (Don't include this note in the final answer): This is a BigQuery dataset which may contain large-scale analytics data, nested structures, and complex data types.";
  }

  prompt += `

        Provide a direct, concise description of what this database represents and its business purpose.
        Do NOT start with phrases like "This database appears to represent" or "This BigQuery dataset".
        Start directly with the domain or business area description.
        Focus on the overall data model and its intended use.
        Example: "Healthcare-related database with a focus on patient management..." instead of "This database appears to represent a healthcare-related system..."
        `;

  return prompt.trim();
}

export class KtxDescriptionGenerator {
  private readonly llmProvider: KtxLlmProvider;
  private readonly cache?: KtxDescriptionCachePort;
  private readonly logger?: KtxScanLoggerPort;
  private readonly settings: ResolvedKtxDescriptionGenerationSettings;

  constructor(options: KtxDescriptionGeneratorOptions) {
    this.llmProvider = options.llmProvider;
    this.cache = options.cache;
    this.logger = options.logger;
    this.settings = {
      columnMaxWords: options.settings.columnMaxWords,
      tableMaxWords: options.settings.tableMaxWords,
      dataSourceMaxWords: options.settings.dataSourceMaxWords,
      ...(options.settings.temperature !== undefined ? { temperature: options.settings.temperature } : {}),
      concurrencyLimit: options.settings.concurrencyLimit ?? 5,
    };
  }

  async generateColumnDescriptions(input: KtxGenerateColumnDescriptionsInput): Promise<KtxColumnAnalysisResult> {
    const columnsToProcess = input.table.columns;
    const tableContext = `Table: ${input.table.name} | Columns: ${columnsToProcess.map((column) => column.name).join(', ')} | Data source: ${input.dataSourceType}`;

    const results = await runWithConcurrency(columnsToProcess, this.settings.concurrencyLimit, async (column) =>
      this.generateOneColumnDescription(input, column, tableContext),
    );

    const columnDescriptions: Array<[string, string | null]> = [];
    const processedColumns: string[] = [];
    const skippedColumns: string[] = [];

    for (const result of results) {
      columnDescriptions.push([result.columnName, result.description]);
      if (result.skipped) {
        skippedColumns.push(result.columnName);
      } else if (result.processed) {
        processedColumns.push(result.columnName);
      }
    }

    return {
      columnDescriptions,
      processedColumns,
      skippedColumns,
    };
  }

  async generateTableDescription(input: KtxGenerateTableDescriptionInput): Promise<string | null> {
    const tableRef = toTableRef(input.table);
    const cacheKey = this.cache?.buildTableKey(tableRef);
    if (cacheKey) {
      const cached = await this.cache?.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    if (!input.connector.sampleTable) {
      this.logger?.warn('KTX scan connector does not support table sampling for table description generation', {
        connectorId: input.connector.id,
        table: input.table.name,
      });
      return 'Table not found';
    }

    try {
      const sampleData = await input.connector.sampleTable(
        {
          connectionId: input.connectionId,
          table: tableRef,
          limit: 20,
        },
        input.context,
      );
      const prompt = buildKtxTableDescriptionPrompt({
        tableName: input.table.name,
        sampleData,
        dataSourceType: input.dataSourceType,
        rawDescriptions: input.table.rawDescriptions,
      });
      const description = await this.generateAiDescription(
        prompt,
        this.settings.tableMaxWords,
        'ktx-table-description',
      );
      if (cacheKey && description) {
        await this.cache?.set(cacheKey, description);
      }
      return description;
    } catch (error) {
      this.logger?.error(`Error generating table description: ${errorMessage(error)}`);
      return 'Table not found';
    }
  }

  async generateDataSourceDescription(input: KtxGenerateDataSourceDescriptionInput): Promise<string | null> {
    if (input.tables.length === 0) {
      return 'No tables found in database';
    }

    const cacheKey = input.connectionName ? this.cache?.buildConnectionKey(input.connectionName) : undefined;
    if (cacheKey) {
      const cached = await this.cache?.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    if (!input.connector.sampleTable) {
      this.logger?.warn('KTX scan connector does not support table sampling for data-source description generation', {
        connectorId: input.connector.id,
      });
      return 'No accessible tables found in database';
    }

    const tablesToAnalyze = input.tables.slice(0, 10);
    const tableSamples = await runWithConcurrency(tablesToAnalyze, this.settings.concurrencyLimit, async (table) => {
      try {
        const sampleData = await input.connector.sampleTable!(
          {
            connectionId: input.connectionId,
            table: toTableRef(table),
            limit: 5,
          },
          input.context,
        );
        return [table.name, sampleData] as [string, KtxTableSampleResult];
      } catch (error) {
        this.logger?.warn(`Failed to sample table '${table.name}' for data source analysis - ${errorMessage(error)}`);
        return null;
      }
    });

    const accessibleSamples = tableSamples.filter(
      (sample): sample is [string, KtxTableSampleResult] => sample !== null,
    );
    if (accessibleSamples.length === 0) {
      return 'No accessible tables found in database';
    }

    try {
      const prompt = buildKtxDataSourceDescriptionPrompt({
        tableSamples: accessibleSamples,
        dataSourceType: input.dataSourceType,
      });
      const description = await this.generateAiDescription(
        prompt,
        this.settings.dataSourceMaxWords,
        'ktx-data-source-description',
      );
      if (cacheKey && description) {
        await this.cache?.set(cacheKey, description);
      }
      return description;
    } catch (error) {
      this.logger?.error(`Error generating data source description: ${errorMessage(error)}`);
      return 'Failed to generate data source description';
    }
  }

  private async generateOneColumnDescription(
    input: KtxGenerateColumnDescriptionsInput,
    column: KtxDescriptionColumn,
    tableContext: string,
  ): Promise<ColumnTaskResult> {
    const existingDescription = input.existingDescriptions?.[column.name];
    if (input.skipExisting && existingDescription) {
      return {
        columnName: column.name,
        description: existingDescription,
        skipped: true,
        processed: false,
      };
    }

    const tableRef = toTableRef(input.table);
    const cacheKey = this.cache?.buildColumnKey(tableRef, column.name);
    if (cacheKey) {
      const cached = await this.cache?.get(cacheKey);
      if (cached) {
        return {
          columnName: column.name,
          description: cached,
          skipped: true,
          processed: false,
        };
      }
    }

    try {
      let columnValues = column.sampleValues;
      if (!columnValues || columnValues.length === 0) {
        if (!input.connector.sampleColumn) {
          this.logger?.warn('KTX scan connector does not support column sampling for column description generation', {
            connectorId: input.connector.id,
            table: input.table.name,
            column: column.name,
          });
          return {
            columnName: column.name,
            description: null,
            skipped: false,
            processed: false,
          };
        }

        const sample = await input.connector.sampleColumn(
          {
            connectionId: input.connectionId,
            table: tableRef,
            column: column.name,
            limit: 50,
          },
          input.context,
        );
        columnValues = sample.values;
      }

      const nonNullValues = (columnValues ?? []).filter((value) => value !== null && value !== undefined);
      if (nonNullValues.length === 0) {
        return {
          columnName: column.name,
          description: null,
          skipped: false,
          processed: false,
        };
      }

      const prompt = buildKtxColumnDescriptionPrompt({
        columnName: column.name,
        columnValues: nonNullValues,
        tableContext,
        dataSourceType: input.dataSourceType,
        supportsNestedAnalysis: input.supportsNestedAnalysis,
        rawDescriptions: column.rawDescriptions,
      });
      const description = await this.generateAiDescription(
        prompt,
        this.settings.columnMaxWords,
        'ktx-column-description',
      );

      if (cacheKey && description) {
        await this.cache?.set(cacheKey, description);
      }

      return {
        columnName: column.name,
        description,
        skipped: false,
        processed: description !== null,
      };
    } catch (error) {
      this.logger?.error(`Error analyzing column '${column.name}': ${errorMessage(error)}`);
      return {
        columnName: column.name,
        description: null,
        skipped: false,
        processed: false,
      };
    }
  }

  private async generateAiDescription(prompt: string, maxWords: number, _operationName: string): Promise<string | null> {
    try {
      const text = await generateKtxText({
        llmProvider: this.llmProvider,
        role: 'candidateExtraction',
        prompt: appendKtxWordLimitInstruction(prompt, maxWords),
        temperature: this.settings.temperature,
      });
      const description = text.trim();
      return description || null;
    } catch (error) {
      this.logger?.error(`Error generating AI description: ${errorMessage(error)}`);
      return null;
    }
  }
}
