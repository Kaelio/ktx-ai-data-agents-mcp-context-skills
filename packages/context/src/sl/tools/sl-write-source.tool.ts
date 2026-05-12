import YAML from 'yaml';
import { z } from 'zod';
import { addTouchedSlSource, type ToolContext, type ToolOutput } from '../../tools/index.js';
import { sourceOverlaySchema } from '../schemas.js';
import type { SemanticLayerService } from '../semantic-layer.service.js';
import type { SemanticLayerSource } from '../types.js';
import {
  BaseSemanticLayerTool,
  type BaseSemanticLayerToolDeps,
  type SemanticLayerStructured,
  sourceDefinitionSchema,
} from './base-semantic-layer.tool.js';
import { normalizeSemanticLayerDescriptions } from '../description-normalization.js';
import { slToolConnectionIdSchema } from './connection-id-schema.js';

const sourceInputSchema = z.union([sourceDefinitionSchema, sourceOverlaySchema]);

const slWriteSourceInputSchema = z.object({
  connectionId: slToolConnectionIdSchema.describe('Data source connection ID'),
  sourceName: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_]*$/, 'Source name must be snake_case (lowercase alphanumeric and underscores)')
    .describe('Name of the source to create, edit, or delete'),
  source: sourceInputSchema
    .optional()
    .describe('Source definition (standalone with table/sql) or overlay (measures, computed columns, etc.)'),
  delete: z.boolean().optional().describe('Set to true to delete this source entirely'),
});

type SlWriteSourceInput = z.infer<typeof slWriteSourceInputSchema>;

function actionTargetConnectionId(
  runConnectionId: string | null | undefined,
  actionConnectionId: string,
): string | null {
  return runConnectionId && runConnectionId !== actionConnectionId ? actionConnectionId : null;
}

export class SlWriteSourceTool extends BaseSemanticLayerTool<typeof slWriteSourceInputSchema> {
  readonly name = 'sl_write_source';

  constructor(deps: BaseSemanticLayerToolDeps) {
    super(deps);
  }

  get description(): string {
    return `<purpose>
Create a new semantic layer source or fully rewrite an existing one.
If the source already exists, this tool will overwrite it with the new definition.
</purpose>

<when_to_use>
- First time creating a source definition
- When modeling a new SQL-backed source (e.g., churn risk view, ARR calculation)
- When the user asks to start over / fully rewrite a source
- Consolidating multiple sources into one (write merged definition)
- For targeted edits to existing sources (add/remove measures, update joins), prefer sl_edit_source instead
</when_to_use>

<editing_approach>
- New source: provide \`source\` with full definition
- Full rewrite: provide \`source\` (overwrites existing)
- Targeted edits on an existing source: use sl_edit_source instead
- Delete: set \`delete: true\`
</editing_approach>

<source_definition>
- name: Unique identifier for the source
- table: For physical table/view sources (e.g., "public.orders"). Mutually exclusive with sql.
- sql: For SQL-based sources (the SQL query). Mutually exclusive with table.
- grain: What one row represents (e.g., ["id"], ["customer_id", "product_id"])
- columns: All columns with type (string/number/time/boolean) and optional descriptions
- joins: Relationships to other sources (to, on, relationship: many_to_one/one_to_many/one_to_one)
- measures: Pre-defined aggregations (name, expr like "sum(amount)", optional filter, optional segments — bare names of segments defined on the same source, optional description)
- segments: Named, reusable boolean predicates scoped to this source (name, expr — a SQL boolean over this source's columns, optional description). A measure references one with \`segments: [name]\`; a query references one with the dotted form \`source.segment_name\`. Use when the same predicate appears on 3+ measures — e.g. extract \`is_paid = true and is_refunded = '0'\` as \`segments: [{name: paid_non_refunded, expr: "..."}]\` and have each measure use \`segments: [paid_non_refunded]\` instead of re-typing the predicate inside \`sum(case when ... then x end)\`. Segments are predicates only — they cannot be selected as dimensions or grouped by; if you need to group by the predicate, add a \`columns[]\` entry instead.
</source_definition>

<join_requirements>
Sources with joins: [] are disconnected from the semantic layer join graph and cannot be composed with other sources in semantic queries.
Before writing, use discover_data to check existing sources and their grain columns.
For each grain/key column in your source (e.g., account_id, item_id), find the matching dimension source (e.g., ACCOUNTS, ITEMS) and declare a many_to_one join.
Example: a source graining on [account_id] should declare:
  joins:
    - to: ACCOUNTS
      on: source_name.account_id = ACCOUNTS.ACCOUNT_ID
      relationship: many_to_one
The on condition format: local_column = TARGET_SOURCE.target_column (right side must include target source name).
Do NOT join back to a table that the SQL already aggregates from if the grain column is not in the output (the relationship is already baked into the SQL).
</join_requirements>`;
  }

  get inputSchema() {
    return slWriteSourceInputSchema;
  }

  async call(input: SlWriteSourceInput, context: ToolContext): Promise<ToolOutput<SemanticLayerStructured>> {
    const { connectionId, sourceName } = input;
    const { name: author, email: authorEmail } = await this.authorResolver.resolve(context.userId);

    const semanticLayerService = context.session?.semanticLayerService ?? this.semanticLayerService;
    const skipIndex = context.session?.isWorktreeScoped === true;

    // Handle delete
    if (input.delete) {
      try {
        await semanticLayerService.deleteSource(connectionId, sourceName, author, authorEmail);
        if (!skipIndex) {
          const allSources = await semanticLayerService.loadAllSources(connectionId);
          await this.slSearchService.indexSources(connectionId, allSources).catch(() => {});
        }
        if (context.session) {
          addTouchedSlSource(context.session.touchedSlSources, connectionId, sourceName);
          context.session.actions.push({
            target: 'sl',
            type: 'removed',
            key: sourceName,
            detail: 'Deleted source',
            targetConnectionId: actionTargetConnectionId(context.session.connectionId, connectionId),
          });
        }
        return this.buildOutput(true, [], sourceName, { yaml: undefined, commitHash: undefined });
      } catch (error) {
        return this.buildOutput(false, [error instanceof Error ? error.message : String(error)], sourceName);
      }
    }

    // Require source for create/rewrite
    if (!input.source) {
      return this.buildOutput(
        false,
        ['Provide `source` to create or rewrite. For targeted edits, use sl_edit_source.'],
        sourceName,
      );
    }

    return this.writeFullSource(
      connectionId,
      input.source,
      sourceName,
      author,
      authorEmail,
      context,
      semanticLayerService,
      skipIndex,
    );
  }

  private async writeFullSource(
    connectionId: string,
    source: z.infer<typeof sourceInputSchema>,
    sourceName: string,
    author: string,
    authorEmail: string,
    context: ToolContext,
    semanticLayerService: SemanticLayerService,
    skipIndex: boolean,
  ): Promise<ToolOutput<SemanticLayerStructured>> {
    const normalizedSource = normalizeSemanticLayerDescriptions(source, { fillMissing: !!context.session?.ingest });
    const isOverlay =
      !('table' in normalizedSource && normalizedSource.table) && !('sql' in normalizedSource && normalizedSource.sql);

    const existing = await this.readSourceYamlFromService(semanticLayerService, connectionId, sourceName);
    const commitMessage = existing
      ? `${isOverlay ? 'Update overlay' : 'Rewrite source'}: ${sourceName}`
      : `${isOverlay ? 'Create overlay' : 'Create source'}: ${sourceName}`;

    const yamlContent = YAML.stringify(normalizedSource, { indent: 2, lineWidth: 0, version: '1.1' });

    const orphanError = await this.rejectOrphanOverlay(semanticLayerService, connectionId, sourceName, yamlContent);
    if (orphanError) {
      return this.buildOutput(false, [orphanError], sourceName, { yaml: yamlContent });
    }
    const shadowError = await this.rejectStandaloneShadow(semanticLayerService, connectionId, sourceName, yamlContent);
    if (shadowError) {
      return this.buildOutput(false, [shadowError], sourceName, { yaml: yamlContent });
    }

    const validatedSource = normalizedSource as SemanticLayerSource;
    const validationResult = await semanticLayerService.validateWithProposedSource(connectionId, validatedSource);
    const validationErrors = validationResult.errors;
    const validationWarnings = [...validationResult.warnings];
    const actionRequiredWarnings = validationResult.perSourceWarnings?.[sourceName] ?? [];
    if (validationErrors.length > 0) {
      return this.buildOutput(false, ['Validation failed — source was NOT saved:', ...validationErrors], sourceName, {
        yaml: yamlContent,
        validationErrors,
        validationWarnings,
        actionRequiredWarnings,
      });
    }

    try {
      const result = await semanticLayerService.writeSource(
        connectionId,
        validatedSource,
        author,
        authorEmail,
        commitMessage,
      );

      if (!skipIndex) {
        const allSources = await semanticLayerService.loadAllSources(connectionId);
        await this.slSearchService.indexSources(connectionId, allSources).catch(() => {});
      }

      if (context.session) {
        addTouchedSlSource(context.session.touchedSlSources, connectionId, sourceName);
        context.session.actions.push({
          target: 'sl',
          type: existing ? 'updated' : 'created',
          key: sourceName,
          detail: existing ? `Rewrote source` : `Created source`,
          targetConnectionId: actionTargetConnectionId(context.session.connectionId, connectionId),
        });
      }

      return this.buildOutput(true, [], sourceName, {
        yaml: yamlContent,
        commitHash: result.commitHash ?? undefined,
        validationErrors,
        validationWarnings,
        actionRequiredWarnings,
      });
    } catch (error) {
      return this.buildOutput(false, [error instanceof Error ? error.message : String(error)], sourceName);
    }
  }

  private async readSourceYamlFromService(
    service: SemanticLayerService,
    connectionId: string,
    sourceName: string,
  ): Promise<string | null> {
    try {
      const { content } = await service.readSourceFile(connectionId, sourceName);
      return content;
    } catch {
      return null;
    }
  }

  private async rejectOrphanOverlay(
    semanticLayerService: SemanticLayerService,
    connectionId: string,
    sourceName: string,
    content: string,
  ): Promise<string | null> {
    let parsed: Record<string, unknown>;
    try {
      parsed = YAML.parse(content) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const isOverlay = !('table' in parsed && parsed.table) && !('sql' in parsed && parsed.sql);
    if (!isOverlay) {
      return null;
    }

    const manifestNames = await semanticLayerService.listManifestSourceNames(connectionId);
    if (manifestNames.includes(sourceName)) {
      return null;
    }

    const suggestions = this.nearestMatches(sourceName, manifestNames, 3);
    return [
      `Error: cannot write "${sourceName}" as an overlay — no manifest entry with that name exists.`,
      suggestions.length > 0
        ? `  Nearest manifest matches: ${suggestions.join(', ')}.`
        : `  No manifest entries resemble "${sourceName}".`,
      `To customize an existing base table, retarget the overlay at one of the nearest matches.`,
      `For a LookML derived_table or any source backed by inline SQL, rewrite as a standalone`,
      `curated source with a top-level "sql:" block plus explicit "grain:" and "columns:".`,
    ].join('\n');
  }

  private async rejectStandaloneShadow(
    semanticLayerService: SemanticLayerService,
    connectionId: string,
    sourceName: string,
    content: string,
  ): Promise<string | null> {
    let parsed: Record<string, unknown>;
    try {
      parsed = YAML.parse(content) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const isOverlay = !('table' in parsed && parsed.table) && !('sql' in parsed && parsed.sql);
    if (isOverlay) {
      return null;
    }

    const isManifestBacked = await semanticLayerService.isManifestBacked(connectionId, sourceName);
    if (!isManifestBacked) {
      return null;
    }

    return [
      `Error: cannot write "${sourceName}" as a standalone source — a manifest entry with that name already exists.`,
      `  Writing standalone would drop the manifest's columns and joins, leaving only what you list here.`,
      `To add measures/segments on top of the manifest, rewrite this YAML as an overlay:`,
      `  - Remove "sql:", "table:", "grain:", "columns:", and "joins:".`,
      `  - Keep only "name:", plus "measures:", "segments:", and/or "description:".`,
      `  - The manifest's schema is inherited automatically.`,
      `If you really need a different base table, use a different source name.`,
    ].join('\n');
  }

  private nearestMatches(needle: string, haystack: string[], limit: number): string[] {
    if (haystack.length === 0) {
      return [];
    }
    const lowerNeedle = needle.toLowerCase();
    const scored = haystack.map((candidate) => {
      const lower = candidate.toLowerCase();
      const prefixBoost = lower.startsWith(lowerNeedle) || lowerNeedle.startsWith(lower) ? 0.2 : 0;
      const substringBoost = lower.includes(lowerNeedle) || lowerNeedle.includes(lower) ? 0.1 : 0;
      const score = jaroWinkler(lowerNeedle, lower) + prefixBoost + substringBoost;
      return { candidate, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored
      .filter((s) => s.score > 0.4)
      .slice(0, limit)
      .map((s) => s.candidate);
  }
}

function jaroWinkler(a: string, b: string): number {
  if (a === b) {
    return 1;
  }
  const matchDistance = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatches = new Array<boolean>(a.length).fill(false);
  const bMatches = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatches[j]) {
        continue;
      }
      if (a[i] !== b[j]) {
        continue;
      }
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) {
    return 0;
  }
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) {
      continue;
    }
    while (!bMatches[k]) {
      k++;
    }
    if (a[i] !== b[k]) {
      transpositions++;
    }
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  const maxPrefix = Math.min(4, a.length, b.length);
  while (prefix < maxPrefix && a[prefix] === b[prefix]) {
    prefix++;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}
