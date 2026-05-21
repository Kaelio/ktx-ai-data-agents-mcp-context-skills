import { z } from 'zod';
import type { ToolContext, ToolOutput } from '../../tools/index.js';
import { BaseSemanticLayerTool, type BaseSemanticLayerToolDeps } from './base-semantic-layer.tool.js';
import { slToolConnectionIdSchema } from './connection-id-schema.js';

const slReadSourceInputSchema = z.object({
  connectionId: slToolConnectionIdSchema.describe('Data source connection ID'),
  sourceName: z.string().describe('Name of the source to read'),
});

type SlReadSourceInput = z.infer<typeof slReadSourceInputSchema>;

interface SlReadSourceStructured {
  sourceName: string;
  yaml: string;
}

export class SlReadSourceTool extends BaseSemanticLayerTool<typeof slReadSourceInputSchema> {
  readonly name = 'sl_read_source';

  constructor(deps: BaseSemanticLayerToolDeps) {
    super(deps);
  }

  get description(): string {
    return `<purpose>
Read the raw YAML definition of a semantic layer source, including its SQL implementation.
Use this when you need to understand how a source is built — e.g., before editing it with sl_edit_source or sl_write_source.
</purpose>

<when_to_use>
- Before editing a source: understand its full definition (SQL, columns, measures, joins)
- When debugging a source: see the underlying SQL query
- When creating a new source based on an existing one
</when_to_use>

<when_not_to_use>
- To discover what sources/measures/dimensions are available for querying — use sl_discover instead
- To query data — use the semantic-layer query surface (\`sl_query\` in MCP)
</when_not_to_use>`;
  }

  get inputSchema() {
    return slReadSourceInputSchema;
  }

  async call(input: SlReadSourceInput, context: ToolContext): Promise<ToolOutput<SlReadSourceStructured>> {
    const { connectionId, sourceName } = input;

    const yaml = await this.readSourceYaml(connectionId, sourceName, context);
    if (!yaml) {
      return {
        markdown: `Source **${sourceName}** not found for connection ${connectionId}.`,
        structured: { sourceName, yaml: '' },
      };
    }

    return {
      markdown: `## Source: ${sourceName}\n\n\`\`\`yaml\n${yaml}\n\`\`\``,
      structured: { sourceName, yaml },
    };
  }
}
