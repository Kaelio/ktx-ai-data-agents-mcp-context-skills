import { z } from 'zod';
import type { KtxTableRef } from '../../../scan/types.js';
import { BaseTool, type ToolContext, type ToolOutput } from '../../../tools/index.js';
import { WarehouseCatalogService, type TableDetail } from './warehouse-catalog.service.js';

const targetSchema = z.union([
  z.object({ display: z.string().min(1) }),
  z.object({
    catalog: z.string().nullable(),
    db: z.string().nullable(),
    name: z.string().min(1),
    column: z.string().optional(),
  }),
]);

const entityDetailsInputSchema = z.object({
  connectionName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  targets: z.array(targetSchema).min(1).max(50),
});

type EntityDetailsInput = z.infer<typeof entityDetailsInputSchema>;

export interface EntityDetailsStructured {
  resolved: TableDetail[];
  missing: Array<{ target: unknown; candidates: KtxTableRef[] }>;
  scanAvailable: boolean;
}

function allowedConnectionNames(context: ToolContext): ReadonlySet<string> | null {
  return context.session?.allowedConnectionNames ?? null;
}

function sampleText(values: string[]): string {
  return values.length > 0 ? ` - sample: ${JSON.stringify(values.slice(0, 10))}` : '';
}

function appendTableMarkdown(parts: string[], detail: TableDetail, columnName?: string): void {
  const columns = columnName ? detail.columns.filter((column) => column.name === columnName) : detail.columns;
  parts.push(`### ${detail.display}`);
  parts.push(`Type: ${detail.kind} | Native columns: ${detail.columns.length}`);
  if (detail.description || detail.comment) {
    parts.push(`Description: ${detail.description ?? detail.comment}`);
  }
  parts.push('', 'Columns:');
  for (const column of columns) {
    const pk = column.primaryKey ? ', PK' : '';
    parts.push(`- ${column.name} (${column.nativeType}, nullable=${column.nullable}${pk})${sampleText(column.sampleValues)}`);
  }
  parts.push('');
}

export class EntityDetailsTool extends BaseTool<typeof entityDetailsInputSchema> {
  readonly name = 'entity_details';

  constructor(private readonly catalogFactory: (context: ToolContext) => WarehouseCatalogService) {
    super();
  }

  get description(): string {
    return 'Verify warehouse tables and columns from the latest live-database scan before writing them into wiki or semantic-layer output.';
  }

  get inputSchema() {
    return entityDetailsInputSchema;
  }

  async call(input: EntityDetailsInput, context: ToolContext): Promise<ToolOutput<EntityDetailsStructured>> {
    const allowed = allowedConnectionNames(context);
    if (allowed && !allowed.has(input.connectionName)) {
      return {
        markdown: `Connection "${input.connectionName}" is not available to this ingest stage.`,
        structured: { resolved: [], missing: [], scanAvailable: false },
      };
    }

    const catalog = this.catalogFactory(context);
    const scanAvailable = await catalog.hasScan(input.connectionName);
    if (!scanAvailable) {
      return {
        markdown: `No live-database scan available for connection "${input.connectionName}"; run \`ktx scan\` first.`,
        structured: { resolved: [], missing: [], scanAvailable: false },
      };
    }

    const parts: string[] = [];
    const resolved: TableDetail[] = [];
    const missing: EntityDetailsStructured['missing'] = [];

    for (const target of input.targets) {
      const resolution =
        'display' in target
          ? await catalog.resolveDisplay(input.connectionName, target.display)
          : { resolved: { catalog: target.catalog, db: target.db, name: target.name }, candidates: [], dialect: '' };
      if (!resolution.resolved) {
        missing.push({ target, candidates: resolution.candidates });
        parts.push(`Not found in scan: ${'display' in target ? target.display : target.name}`);
        if (resolution.candidates.length > 0) {
          parts.push(`Closest matches: ${resolution.candidates.map((candidate) => candidate.name).join(', ')}`);
        }
        continue;
      }
      const detail = await catalog.getTable({ connectionName: input.connectionName, ...resolution.resolved });
      if (!detail) {
        missing.push({ target, candidates: resolution.candidates });
        continue;
      }
      resolved.push(detail);
      appendTableMarkdown(parts, detail, 'column' in target ? target.column : undefined);
    }

    return {
      markdown: parts.join('\n').trim(),
      structured: { resolved, missing, scanAvailable: true },
    };
  }
}
