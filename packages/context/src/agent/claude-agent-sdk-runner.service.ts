import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { KtxModelRole } from '@ktx/llm';
import { noopLogger, type KtxLogger } from '../core/index.js';
import {
  agentToolOutputToText,
  assertAgentToolSet,
  type AgentToolDefinition,
  type AgentToolSet,
} from './agent-tool.js';
import type { AgentRunnerPort, RunLoopParams, RunLoopResult, RunLoopStopReason } from './agent-runner.service.js';

type QueryFn = typeof query;
type CreateSdkMcpServerFn = typeof createSdkMcpServer;
type ToolFn = typeof tool;

const BUILT_IN_TOOLS = [
  'Agent',
  'AskUserQuestion',
  'Bash',
  'Edit',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'ListMcpResources',
  'NotebookEdit',
  'Read',
  'ReadMcpResource',
  'Task',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
];

export interface ClaudeAgentSdkRunnerServiceDeps {
  projectDir: string;
  modelSlots: Partial<Record<KtxModelRole, string>>;
  query?: QueryFn;
  createSdkMcpServer?: CreateSdkMcpServerFn;
  tool?: ToolFn;
  logger?: KtxLogger;
}

export class ClaudeAgentSdkRunnerService implements AgentRunnerPort {
  private readonly query: QueryFn;
  private readonly createSdkMcpServer: CreateSdkMcpServerFn;
  private readonly tool: ToolFn;
  private readonly logger: KtxLogger;

  constructor(private readonly deps: ClaudeAgentSdkRunnerServiceDeps) {
    this.query = deps.query ?? query;
    this.createSdkMcpServer = deps.createSdkMcpServer ?? createSdkMcpServer;
    this.tool = deps.tool ?? tool;
    this.logger = deps.logger ?? noopLogger;
  }

  async runLoop(params: RunLoopParams): Promise<RunLoopResult> {
    try {
      assertAgentToolSet(params.toolSet);
      const result = await this.consumeQuery(params);
      return { stopReason: this.mapResultToStopReason(result) };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(`[claude-agent-sdk-runner] loop failed: ${err.message}`);
      return { stopReason: 'error', error: err };
    }
  }

  private async consumeQuery(params: RunLoopParams): Promise<SDKResultMessage | undefined> {
    let result: SDKResultMessage | undefined;
    let stepIndex = 0;
    const session = this.query({
      prompt: params.userPrompt,
      options: {
        cwd: this.deps.projectDir,
        systemPrompt: params.systemPrompt,
        maxTurns: params.stepBudget,
        ...this.modelOption(params.modelRole),
        mcpServers: {
          ktx: this.createSdkMcpServer({
            name: 'ktx',
            version: '1.0.0',
            tools: Object.values(params.toolSet).map((definition) => this.toSdkTool(definition)),
          }),
        },
        tools: [],
        settingSources: [],
        skills: [],
        allowedTools: ['mcp__ktx__*'],
        disallowedTools: BUILT_IN_TOOLS,
        permissionMode: 'dontAsk',
        canUseTool: this.canUseKtxTool,
      },
    });

    for await (const message of session as AsyncIterable<SDKMessage>) {
      if (message.type === 'assistant') {
        stepIndex += 1;
        if (params.onStepFinish) {
          await params.onStepFinish({ stepIndex, stepBudget: params.stepBudget });
        }
      }
      if (message.type === 'result') {
        result = message;
      }
    }
    return result;
  }

  private modelOption(role: KtxModelRole): { model?: string } {
    const model = this.deps.modelSlots[role] ?? this.deps.modelSlots.default;
    return model ? { model } : {};
  }

  private toSdkTool(definition: AgentToolDefinition) {
    return this.tool(definition.name, definition.description, definition.inputSchema.shape, async (args) => {
      const output = await definition.execute(definition.inputSchema.parse(args), {});
      return { content: [{ type: 'text' as const, text: agentToolOutputToText(output) }] };
    });
  }

  private readonly canUseKtxTool: CanUseTool = async (toolName) => {
    if (toolName.startsWith('mcp__ktx__')) {
      return { behavior: 'allow', updatedInput: undefined };
    }
    return {
      behavior: 'deny',
      message: 'Only KTX MCP tools are available in this session.',
    };
  };

  private mapResultToStopReason(result: SDKResultMessage | undefined): RunLoopStopReason {
    if (!result) {
      return 'error';
    }
    if (result.subtype === 'error_max_turns' || result.terminal_reason === 'max_turns') {
      return 'budget';
    }
    if (result.subtype === 'success' && (!result.terminal_reason || result.terminal_reason === 'completed')) {
      return 'natural';
    }
    return 'error';
  }
}
