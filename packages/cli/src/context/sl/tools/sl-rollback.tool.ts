import { z } from 'zod';
import { BaseTool, deleteTouchedSlSource, type ToolContext, type ToolOutput } from '../../tools/index.js';
import type { SlConnectionCatalogPort, SlSourcesIndexPort } from '../ports.js';
import { revertSourceToPreHead } from './sl-warehouse-validation.js';

const slRollbackInputSchema = z.object({
  sourceName: z.string().describe('Name of the source to roll back'),
});

type SlRollbackInput = z.infer<typeof slRollbackInputSchema>;

interface SlRollbackStructured {
  success: boolean;
  sourceName: string;
  outcome?: string;
}

export class SlRollbackTool extends BaseTool<typeof slRollbackInputSchema> {
  readonly name = 'sl_rollback';

  constructor(
    private readonly slSourcesRepository: SlSourcesIndexPort,
    private readonly connections: SlConnectionCatalogPort,
    private readonly probeRowCount: number,
  ) {
    super();
  }

  get description(): string {
    return `<purpose>
Abandon this-session changes to a source and restore it to its pre-session state.
Use when a write/edit failed validation in a way you cannot fix in-session (e.g. the source requires elevated warehouse permissions).
</purpose>`;
  }

  get inputSchema() {
    return slRollbackInputSchema;
  }

  async call(input: SlRollbackInput, context: ToolContext): Promise<ToolOutput<SlRollbackStructured>> {
    const session = context.session;
    if (!session) {
      return {
        markdown:
          'Error: sl_rollback requires an active session (ingest WU or memory-agent). Use git revert for interactive rollback.',
        structured: { success: false, sourceName: input.sourceName },
      };
    }
    if (!session.connectionId) {
      return {
        markdown: 'Error: sl_rollback requires a connection-scoped session; this session has no warehouse connection.',
        structured: { success: false, sourceName: input.sourceName },
      };
    }

    const outcome = await revertSourceToPreHead(
      {
        semanticLayerService: session.semanticLayerService,
        connections: this.connections,
        configService: session.configService,
        gitService: session.gitService,
        slSourcesRepository: this.slSourcesRepository,
        probeRowCount: this.probeRowCount,
      },
      session.connectionId,
      session.preHead,
      input.sourceName,
    );

    deleteTouchedSlSource(session.touchedSlSources, session.connectionId, input.sourceName);
    for (let i = session.actions.length - 1; i >= 0; i--) {
      const a = session.actions[i];
      if (
        a.target === 'sl' &&
        a.key === input.sourceName &&
        (a.targetConnectionId ?? session.connectionId) === session.connectionId
      ) {
        session.actions.splice(i, 1);
      }
    }

    return {
      markdown: `Source "${input.sourceName}" rolled back: ${outcome}.`,
      structured: { success: true, sourceName: input.sourceName, outcome },
    };
  }
}
