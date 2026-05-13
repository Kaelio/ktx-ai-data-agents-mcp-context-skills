import YAML from 'yaml';
import { z } from 'zod';
import { addTouchedSlSource, type ToolContext, type ToolOutput, validateActionRawPaths } from '../../tools/index.js';
import { applySqlEdits } from '../../tools/sql-edit-replacer.js';
import { normalizeSemanticLayerDescriptions } from '../description-normalization.js';
import type { SemanticLayerSource } from '../types.js';
import {
  BaseSemanticLayerTool,
  type BaseSemanticLayerToolDeps,
  type SemanticLayerStructured,
} from './base-semantic-layer.tool.js';
import { slToolConnectionIdSchema } from './connection-id-schema.js';

const slEditSourceInputSchema = z.object({
  connectionId: slToolConnectionIdSchema.describe('Data source connection ID'),
  sourceName: z.string().describe('Name of the source to edit'),
  yaml_edits: z
    .array(
      z.object({
        oldText: z.string().describe('Exact text to find in the current YAML. Must match exactly (byte-for-byte).'),
        newText: z.string().describe('Replacement text. Use empty string to delete.'),
        reason: z.string().optional().describe('Brief reason for this edit.'),
      }),
    )
    .optional()
    .describe('Targeted exact-match search/replace edits on the raw YAML content.'),
  delete: z.boolean().optional().describe('Set to true to delete this source entirely'),
  rawPaths: z
    .array(z.string().min(1))
    .optional()
    .describe('In ingest sessions, raw source file paths that directly support this SL action.'),
});

type SlEditSourceInput = z.infer<typeof slEditSourceInputSchema>;

function actionTargetConnectionId(
  runConnectionId: string | null | undefined,
  actionConnectionId: string,
): string | null {
  return runConnectionId && runConnectionId !== actionConnectionId ? actionConnectionId : null;
}

export class SlEditSourceTool extends BaseSemanticLayerTool<typeof slEditSourceInputSchema> {
  readonly name = 'sl_edit_source';

  constructor(deps: BaseSemanticLayerToolDeps) {
    super(deps);
  }

  get description(): string {
    return `<purpose>
Make targeted edits to an existing semantic layer source using exact-match search/replace on YAML content.
If no source exists yet, use sl_write_source instead — this tool will reject the call.
</purpose>

<when_to_use>
- Adding/removing a measure on an existing source
- Adding/updating a join relationship
- Updating column descriptions
- Removing an obsolete source (set delete: true)
- Consolidation: delete redundant sources, edit the surviving one
</when_to_use>

<edit_guidelines>
- yaml_edits: exact-match search/replace on raw YAML. oldText must match byte-for-byte (no whitespace normalization or fuzzy matching).
  Include enough surrounding context in oldText for a unique match.
- Read the source first with sl_read_source to copy the exact text you want to replace.
- Keep edits scoped to the user's request — don't proactively regenerate all measures.
</edit_guidelines>`;
  }

  get inputSchema() {
    return slEditSourceInputSchema;
  }

  async call(input: SlEditSourceInput, context: ToolContext): Promise<ToolOutput<SemanticLayerStructured>> {
    const { connectionId, sourceName } = input;
    const { name: author, email: authorEmail } = await this.authorResolver.resolve(context.userId);

    const semanticLayerService = context.session?.semanticLayerService ?? this.semanticLayerService;
    const skipIndex = context.session?.isWorktreeScoped === true;
    const rawPathValidation = validateActionRawPaths(context.session, input.rawPaths);
    if (!rawPathValidation.ok) {
      return this.buildOutput(false, [rawPathValidation.error], sourceName);
    }

    // Handle delete
    if (input.delete) {
      try {
        await semanticLayerService.deleteSource(connectionId, sourceName, author, authorEmail);
        if (context.session) {
          addTouchedSlSource(context.session.touchedSlSources, connectionId, sourceName);
          context.session.actions.push({
            target: 'sl',
            type: 'removed',
            key: sourceName,
            detail: 'Deleted source',
            targetConnectionId: actionTargetConnectionId(context.session.connectionId, connectionId),
            ...(rawPathValidation.rawPaths ? { rawPaths: rawPathValidation.rawPaths } : {}),
          });
        }
        return this.buildOutput(true, [], sourceName, { yaml: undefined, commitHash: undefined });
      } catch (error) {
        return this.buildOutput(false, [error instanceof Error ? error.message : String(error)], sourceName);
      }
    }

    // Read existing source
    let currentYaml: string | null = null;
    try {
      const { content } = await semanticLayerService.readSourceFile(connectionId, sourceName);
      currentYaml = content;
    } catch {
      currentYaml = null;
    }
    if (!currentYaml) {
      const manifestBacked = await semanticLayerService.isManifestBacked(connectionId, sourceName);
      if (manifestBacked) {
        return this.buildOutput(
          false,
          [
            [
              `Source "${sourceName}" exists in the schema manifest but has no overlay file yet — sl_edit_source cannot edit it directly.`,
              `Bootstrap an overlay with sl_write_source, then re-run sl_edit_source on subsequent changes:`,
              `  name: ${sourceName}`,
              `  measures:`,
              `    - name: <measure_name>`,
              `      expr: "<expression>"`,
              `      description: "<what it measures>"`,
              `Overlay shape: "name:" plus any of "measures:", "segments:", "descriptions:". Do NOT include "sql:", "table:", "grain:", "columns:", or "joins:" — those are inherited from the manifest.`,
            ].join('\n'),
          ],
          sourceName,
        );
      }
      return this.buildOutput(false, ['Source not found. Use sl_write_source to create it.'], sourceName);
    }

    const errors: string[] = [];
    let yaml = currentYaml;
    let editCount = 0;

    // Apply yaml_edits (text-level search/replace, exact-match only)
    if (input.yaml_edits && input.yaml_edits.length > 0) {
      const editResult = applySqlEdits(yaml, input.yaml_edits, { exactOnly: true });
      yaml = editResult.sql;
      editCount = editResult.appliedEdits;
      if (!editResult.success) {
        errors.push(...editResult.errors);
      }
    }

    // Parse resulting YAML
    let source: SemanticLayerSource;
    try {
      source = YAML.parse(yaml) as SemanticLayerSource;
    } catch (e) {
      return this.buildOutput(false, [`YAML parse error after edits: ${e}`], sourceName);
    }
    source = normalizeSemanticLayerDescriptions(source, { fillMissing: !!context.session?.ingest });

    // Re-serialize and write
    const updatedYaml = YAML.stringify(source, { indent: 2, lineWidth: 0, version: '1.1' });

    const { errors: validationErrors, warnings: validationWarnings } =
      await semanticLayerService.validateWithProposedSource(connectionId, source);
    if (validationErrors.length > 0) {
      return this.buildOutput(
        false,
        [...errors, 'Validation failed — edits were NOT saved:', ...validationErrors],
        sourceName,
        { yaml: updatedYaml, editCount, validationErrors, validationWarnings },
      );
    }

    const commitMessage = `Edit source ${sourceName}: ${
      input.yaml_edits ? `${input.yaml_edits.length} YAML edit(s)` : 'update'
    }`;

    try {
      const result = await semanticLayerService.writeSource(connectionId, source, author, authorEmail, commitMessage);

      if (!skipIndex) {
        const allSources = await semanticLayerService.loadAllSources(connectionId);
        await this.slSearchService.indexSources(connectionId, allSources).catch(() => {});
      }

      if (context.session) {
        addTouchedSlSource(context.session.touchedSlSources, connectionId, sourceName);
        context.session.actions.push({
          target: 'sl',
          type: 'updated',
          key: sourceName,
          detail: `Applied ${editCount} edit(s)`,
          targetConnectionId: actionTargetConnectionId(context.session.connectionId, connectionId),
          ...(rawPathValidation.rawPaths ? { rawPaths: rawPathValidation.rawPaths } : {}),
        });
      }

      return this.buildOutput(errors.length === 0, errors, sourceName, {
        yaml: updatedYaml,
        commitHash: result.commitHash ?? undefined,
        editCount,
        validationErrors,
        validationWarnings,
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      return this.buildOutput(false, errors, sourceName, { yaml: updatedYaml, editCount });
    }
  }
}
