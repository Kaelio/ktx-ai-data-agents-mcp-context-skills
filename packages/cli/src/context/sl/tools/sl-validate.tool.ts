import { z } from 'zod';
import { type ToolContext, type ToolOutput, touchedSlSourceNamesForConnection } from '../../tools/index.js';
import { SemanticLayerService } from '../semantic-layer.service.js';
import {
  BaseSemanticLayerTool,
  type BaseSemanticLayerToolDeps,
  type SemanticLayerStructured,
} from './base-semantic-layer.tool.js';
import { slToolConnectionIdSchema } from './connection-id-schema.js';

const slValidateInputSchema = z.object({
  connectionId: slToolConnectionIdSchema.describe('Data source connection ID'),
});

type SlValidateInput = z.infer<typeof slValidateInputSchema>;

type ValidationReport = {
  errors: string[];
  warnings: string[];
};

export async function validateSemanticLayerEndpoint(
  connectionId: string,
  semanticLayerService: SemanticLayerService,
): Promise<ValidationReport> {
  try {
    return await semanticLayerService.validateSourcesForConnection(connectionId);
  } catch (e) {
    return {
      errors: [`Validation call failed: ${e instanceof Error ? e.message : String(e)}`],
      warnings: [],
    };
  }
}

export class SlValidateTool extends BaseSemanticLayerTool<typeof slValidateInputSchema> {
  readonly name = 'sl_validate';

  constructor(deps: BaseSemanticLayerToolDeps) {
    super(deps);
  }

  get description(): string {
    return `<purpose>
Validate that all semantic layer sources for a connection form a consistent model.
Checks: all join targets exist, grain is valid, no missing references.
</purpose>

<when_to_use>
- After making edits with sl_write_source
- Before querying, to ensure the model is healthy
- When troubleshooting query failures
</when_to_use>`;
  }

  get inputSchema() {
    return slValidateInputSchema;
  }

  async call(input: SlValidateInput, context: ToolContext): Promise<ToolOutput<SemanticLayerStructured>> {
    const { connectionId } = input;

    const semanticLayerService = context.session?.semanticLayerService ?? this.semanticLayerService;

    const { sources } = await semanticLayerService.loadAllSources(connectionId);
    if (sources.length === 0) {
      return this.buildOutput(true, [], '(all)', {
        validationErrors: ['No sources found for this connection.'],
      });
    }

    let { errors, warnings } = await validateSemanticLayerEndpoint(connectionId, semanticLayerService);

    const touched = context.session?.touchedSlSources;
    if (touched && touched.size > 0) {
      const touchedArr = touchedSlSourceNamesForConnection(touched, connectionId);
      if (touchedArr.length > 0) {
        errors = errors.filter((e) => touchedArr.some((n) => e.includes(n)));
        warnings = warnings.filter((w) => touchedArr.some((n) => w.includes(n)));
      }
    }

    const valid = errors.length === 0;
    const parts: string[] = [];
    parts.push(`**Semantic layer validation** for ${sources.length} source(s):`);

    if (valid && warnings.length === 0) {
      parts.push('All sources are valid. Join graph is consistent.');
    } else {
      const summary: string[] = [];
      if (errors.length > 0) {
        summary.push(`${errors.length} error(s)`);
      }
      if (warnings.length > 0) {
        summary.push(`${warnings.length} warning(s)`);
      }
      parts.push(`Found ${summary.join(' and ')}:`);
      if (errors.length > 0) {
        parts.push('', '**Errors:**');
        for (const err of errors) {
          parts.push(`- ${err}`);
        }
      }
      if (warnings.length > 0) {
        parts.push('', '**Warnings:**');
        for (const warn of warnings) {
          parts.push(`- ${warn}`);
        }
      }
    }

    // List sources summary
    parts.push('\n**Sources:**');
    for (const s of sources) {
      parts.push(
        `- **${s.name}** (${s.sql ? 'sql' : 'table'}): ${s.columns.length} cols, ${s.measures.length} measures, ${s.joins.length} joins`,
      );
    }

    return {
      markdown: parts.join('\n'),
      structured: {
        success: valid,
        sourceName: '(all)',
        validationErrors: errors.length > 0 ? errors : undefined,
        validationWarnings: warnings.length > 0 ? warnings : undefined,
      },
    };
  }
}
