import { z } from 'zod';
import { noopLogger, type KtxLogger } from '../core/config.js';
import { summarizeCodexExecEvents, type CodexExecEventSummary } from './codex-exec-events.js';
import {
  startCodexRuntimeMcpServer,
  type CodexRuntimeMcpServerHandle,
} from './codex-mcp-runtime-server.js';
import { resolveCodexModel } from './codex-models.js';
import { buildCodexRuntimeConfig } from './codex-runtime-config.js';
import { CodexSdkCliRunner, type CodexSdkRunner } from './codex-sdk-runner.js';
import type {
  KtxGenerateObjectInput,
  KtxGenerateTextInput,
  KtxLlmRuntimePort,
  KtxRuntimeToolSet,
  LlmTokenUsage,
  RunLoopParams,
  RunLoopResult,
} from './runtime-port.js';

export interface CodexKtxLlmRuntimeDeps {
  projectDir: string;
  modelSlots: { default: string } & Partial<Record<string, string>>;
  runner?: CodexSdkRunner;
  startMcpServer?: (input: { projectDir: string; toolSet: KtxRuntimeToolSet }) => Promise<CodexRuntimeMcpServerHandle>;
  logger?: KtxLogger;
}

function modelForRole(modelSlots: CodexKtxLlmRuntimeDeps['modelSlots'], role: string): string {
  return resolveCodexModel(modelSlots[role] ?? modelSlots.default);
}

function promptWithSystem(system: string | undefined, prompt: string): string {
  return [system, prompt].filter(Boolean).join('\n\n');
}

async function collectEvents(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const collected: unknown[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function metrics(summary: CodexExecEventSummary, startedAt: number): { totalMs: number; usage: LlmTokenUsage } {
  return { totalMs: Date.now() - startedAt, usage: summary.usage };
}

function assertSuccessfulText(summary: CodexExecEventSummary): string {
  if (summary.error) {
    throw summary.error;
  }
  if (!summary.finalText.trim()) {
    throw new Error('Codex completed without an agent message');
  }
  return summary.finalText;
}

function parseStructuredOutput<TOutput, TSchema extends z.ZodType<TOutput>>(schema: TSchema, text: string): TOutput {
  try {
    return schema.parse(JSON.parse(text));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Codex structured output failed validation: ${message}`);
  }
}

async function mcpForTools(input: {
  projectDir: string;
  toolSet?: KtxRuntimeToolSet;
  startMcpServer: CodexKtxLlmRuntimeDeps['startMcpServer'];
}): Promise<CodexRuntimeMcpServerHandle | undefined> {
  if (!input.toolSet || Object.keys(input.toolSet).length === 0) {
    return undefined;
  }
  return (input.startMcpServer ?? startCodexRuntimeMcpServer)({
    projectDir: input.projectDir,
    toolSet: input.toolSet,
  });
}

function runtimeToolNames(toolSet: KtxRuntimeToolSet | undefined): string[] {
  return Object.values(toolSet ?? {}).map((descriptor) => descriptor.name);
}

export class CodexKtxLlmRuntime implements KtxLlmRuntimePort {
  private readonly runner: CodexSdkRunner;
  private readonly logger: KtxLogger;

  constructor(private readonly deps: CodexKtxLlmRuntimeDeps) {
    this.runner = deps.runner ?? new CodexSdkCliRunner();
    this.logger = deps.logger ?? noopLogger;
  }

  async generateText(input: KtxGenerateTextInput): Promise<string> {
    const startedAt = Date.now();
    const model = modelForRole(this.deps.modelSlots, input.role);
    const mcp = await mcpForTools({
      projectDir: this.deps.projectDir,
      toolSet: input.tools,
      startMcpServer: this.deps.startMcpServer,
    });
    try {
      const config = buildCodexRuntimeConfig({
        model,
        ...(mcp
          ? {
              mcp: {
                url: mcp.url,
                bearerTokenEnvVar: mcp.bearerTokenEnvVar,
                bearerToken: mcp.bearerToken,
                toolNames: runtimeToolNames(input.tools),
              },
            }
          : {}),
      });
      const events = await collectEvents(
        await this.runner.runStreamed({
          projectDir: this.deps.projectDir,
          model,
          prompt: promptWithSystem(input.system, input.prompt),
          configOverrides: config.configOverrides,
          env: config.env,
        }),
      );
      const summary = summarizeCodexExecEvents(events, { startedAt });
      input.onMetrics?.(metrics(summary, startedAt));
      return assertSuccessfulText(summary);
    } finally {
      await mcp?.close();
    }
  }

  async generateObject<TOutput, TSchema extends z.ZodType<TOutput>>(
    input: KtxGenerateObjectInput<TOutput, TSchema>,
  ): Promise<TOutput> {
    const startedAt = Date.now();
    const model = modelForRole(this.deps.modelSlots, input.role);
    const mcp = await mcpForTools({
      projectDir: this.deps.projectDir,
      toolSet: input.tools,
      startMcpServer: this.deps.startMcpServer,
    });
    try {
      const config = buildCodexRuntimeConfig({
        model,
        ...(mcp
          ? {
              mcp: {
                url: mcp.url,
                bearerTokenEnvVar: mcp.bearerTokenEnvVar,
                bearerToken: mcp.bearerToken,
                toolNames: runtimeToolNames(input.tools),
              },
            }
          : {}),
      });
      const events = await collectEvents(
        await this.runner.runStreamed({
          projectDir: this.deps.projectDir,
          model,
          prompt: promptWithSystem(input.system, input.prompt),
          configOverrides: config.configOverrides,
          env: config.env,
          outputSchema: z.toJSONSchema(input.schema, { target: 'draft-7' }) as Record<string, unknown>,
        }),
      );
      const summary = summarizeCodexExecEvents(events, { startedAt });
      input.onMetrics?.(metrics(summary, startedAt));
      return parseStructuredOutput(input.schema, assertSuccessfulText(summary));
    } finally {
      await mcp?.close();
    }
  }

  async runAgentLoop(params: RunLoopParams): Promise<RunLoopResult> {
    const startedAt = Date.now();
    const model = modelForRole(this.deps.modelSlots, params.modelRole);
    let mcp: CodexRuntimeMcpServerHandle | undefined;
    try {
      mcp = await mcpForTools({
        projectDir: this.deps.projectDir,
        toolSet: params.toolSet,
        startMcpServer: this.deps.startMcpServer,
      });
      const config = buildCodexRuntimeConfig({
        model,
        ...(mcp
          ? {
              mcp: {
                url: mcp.url,
                bearerTokenEnvVar: mcp.bearerTokenEnvVar,
                bearerToken: mcp.bearerToken,
                toolNames: runtimeToolNames(params.toolSet),
              },
            }
          : {}),
      });
      const events = await collectEvents(
        await this.runner.runStreamed({
          projectDir: this.deps.projectDir,
          model,
          prompt: promptWithSystem(params.systemPrompt, params.userPrompt),
          configOverrides: config.configOverrides,
          env: config.env,
        }),
      );
      const summary = summarizeCodexExecEvents(events, { startedAt });
      for (let index = 1; index <= summary.stepCount; index += 1) {
        try {
          await params.onStepFinish?.({ stepIndex: index, stepBudget: params.stepBudget });
        } catch (error) {
          this.logger.warn(
            `[codex-runner] onStepFinish callback threw; ignoring: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return {
        stopReason: summary.stopReason,
        ...(summary.stopReason === 'error' && summary.error ? { error: summary.error } : {}),
        metrics: {
          totalMs: Date.now() - startedAt,
          usage: summary.usage,
          stepCount: summary.stepCount,
          stepBoundariesMs: summary.stepBoundariesMs,
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        stopReason: 'error',
        error: err,
        metrics: { totalMs: Date.now() - startedAt, usage: {}, stepCount: 0, stepBoundariesMs: [] },
      };
    } finally {
      await mcp?.close();
    }
  }
}

export async function runCodexAuthProbe(input: {
  projectDir: string;
  model: string;
  runner?: CodexSdkRunner;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  let model: string;
  try {
    model = resolveCodexModel(input.model);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  const runtime = new CodexKtxLlmRuntime({
    projectDir: input.projectDir,
    modelSlots: { default: model },
    ...(input.runner ? { runner: input.runner } : {}),
  });
  try {
    await runtime.generateText({ role: 'default', prompt: 'Reply with exactly: ok' });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `Codex authentication is not usable. Authenticate Codex locally with the Codex CLI, verify the Codex CLI is installed, then rerun setup or the command. ${message}`,
    };
  }
}
