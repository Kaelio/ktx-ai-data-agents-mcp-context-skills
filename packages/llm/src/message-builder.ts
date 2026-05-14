import type { LanguageModel, ModelMessage, ToolSet } from 'ai';
import { isAnthropicProtocolModel } from './model-provider.js';
import type { KtxLlmProvider, KtxPromptCacheTtl, KtxPromptParts } from './types.js';

type ToolMap = ToolSet | Record<string, Record<string, unknown>>;

interface KtxMessageBuilderOptions {
  cacheSystem?: boolean;
  cacheTools?: boolean;
  cacheLastHistory?: boolean;
}

interface KtxBuildInput {
  parts: KtxPromptParts;
  history: ModelMessage[];
  currentMessage: ModelMessage;
  tools: ToolMap;
  model: LanguageModel | string;
}

interface KtxWrapSimpleInput {
  system?: string;
  messages?: ModelMessage[];
  tools?: ToolMap;
  model: LanguageModel | string;
}

interface KtxBuildOutput {
  messages: ModelMessage[];
  tools: ToolMap;
}

export class KtxMessageBuilder {
  constructor(
    private readonly provider: KtxLlmProvider,
    private readonly options: KtxMessageBuilderOptions = {},
  ) {}

  build(input: KtxBuildInput): KtxBuildOutput {
    const cfg = this.provider.promptCachingConfig();
    const cachingActive = cfg.enabled && isAnthropicProtocolModel(input.model);
    const ttls = this.resolveTtls(input.model);
    const messages: ModelMessage[] = [];

    const systemMessage: ModelMessage & { providerOptions?: unknown } = {
      role: 'system',
      content: input.parts.staticSystem,
    };
    if (cachingActive && this.cacheSystemEnabled()) {
      systemMessage.providerOptions = this.provider.cacheMarker(ttls.systemTtl, input.model);
    }
    messages.push(systemMessage);

    if (input.parts.dynamicSystem) {
      messages.push({ role: 'system', content: input.parts.dynamicSystem });
    }

    const historyToEmit =
      cachingActive && this.cacheHistoryEnabled()
        ? this.markLastHistoryMessage(input.history, ttls.historyTtl, input.model)
        : input.history;
    messages.push(...historyToEmit);
    messages.push(this.wrapLeading(input.currentMessage, input.parts.leadingUserContext));

    return {
      messages,
      tools: this.sortAndMarkTools(input.tools, cachingActive, this.cacheToolsEnabled(), ttls.toolsTtl, input.model),
    };
  }

  wrapSimple(input: KtxWrapSimpleInput): KtxBuildOutput {
    const cfg = this.provider.promptCachingConfig();
    const cachingActive = cfg.enabled && isAnthropicProtocolModel(input.model);
    const ttls = this.resolveTtls(input.model);
    const messages: ModelMessage[] = [];

    if (input.system) {
      const systemMessage: ModelMessage & { providerOptions?: unknown } = {
        role: 'system',
        content: input.system,
      };
      if (cachingActive && this.cacheSystemEnabled()) {
        systemMessage.providerOptions = this.provider.cacheMarker(ttls.systemTtl, input.model);
      }
      messages.push(systemMessage);
    }

    if (input.messages) {
      // Only mark a history breakpoint when prior turns exist. A single-message call
      // is the current user turn — marking it writes a cache entry that can't be
      // reused on the next (different-content) call, costing tokens for nothing.
      const shouldMarkHistory =
        cachingActive && this.cacheHistoryEnabled() && input.messages.length > 1;
      messages.push(
        ...(shouldMarkHistory
          ? this.markLastHistoryMessage(input.messages, ttls.historyTtl, input.model)
          : input.messages),
      );
    }

    return {
      messages,
      tools: this.sortAndMarkTools(input.tools ?? {}, cachingActive, this.cacheToolsEnabled(), ttls.toolsTtl, input.model),
    };
  }

  private cacheSystemEnabled(): boolean {
    return this.options.cacheSystem ?? this.provider.promptCachingConfig().cacheSystem;
  }

  private cacheToolsEnabled(): boolean {
    return this.options.cacheTools ?? this.provider.promptCachingConfig().cacheTools;
  }

  private cacheHistoryEnabled(): boolean {
    return this.options.cacheLastHistory ?? this.provider.promptCachingConfig().cacheHistory;
  }

  private resolveTtls(model: LanguageModel | string): {
    systemTtl: KtxPromptCacheTtl;
    toolsTtl: KtxPromptCacheTtl;
    historyTtl: KtxPromptCacheTtl;
  } {
    const cfg = this.provider.promptCachingConfig();
    if (cfg.vertexFallbackTo5m && this.provider.activeBackend() === 'vertex' && isAnthropicProtocolModel(model)) {
      return { systemTtl: '5m', toolsTtl: '5m', historyTtl: '5m' };
    }
    return { systemTtl: cfg.systemTtl, toolsTtl: cfg.toolsTtl, historyTtl: cfg.historyTtl };
  }

  private wrapLeading(currentMessage: ModelMessage, leadingUserContext?: string): ModelMessage {
    if (!leadingUserContext) {
      return currentMessage;
    }
    const reminderPart = {
      type: 'text' as const,
      text: `<system-reminder>\n${leadingUserContext}\n</system-reminder>`,
    };
    if (typeof currentMessage.content === 'string') {
      return {
        ...currentMessage,
        content: [reminderPart, { type: 'text' as const, text: currentMessage.content }],
      } as ModelMessage;
    }
    if (Array.isArray(currentMessage.content)) {
      return { ...currentMessage, content: [reminderPart, ...currentMessage.content] } as ModelMessage;
    }
    return currentMessage;
  }

  private markLastHistoryMessage(
    history: ModelMessage[],
    ttl: KtxPromptCacheTtl,
    model: LanguageModel | string,
  ): ModelMessage[] {
    if (history.length === 0) {
      return history;
    }
    const out = [...history];
    const last = out[out.length - 1];
    const marker = this.provider.cacheMarker(ttl, model);
    if (!marker) {
      return history;
    }
    if (typeof last.content === 'string') {
      out[out.length - 1] = {
        ...last,
        content: [{ type: 'text', text: last.content, providerOptions: marker }],
      } as ModelMessage;
      return out;
    }
    if (Array.isArray(last.content) && last.content.length > 0) {
      const parts = [...last.content];
      const lastPart = parts[parts.length - 1];
      parts[parts.length - 1] = Object.assign({}, lastPart, { providerOptions: marker });
      out[out.length - 1] = { ...last, content: parts } as ModelMessage;
    }
    return out;
  }

  private sortAndMarkTools(
    tools: ToolMap,
    cachingActive: boolean,
    cacheTools: boolean,
    ttl: KtxPromptCacheTtl,
    model: LanguageModel | string,
  ): ToolMap {
    const keys = Object.keys(tools).sort();
    const sorted: Record<string, unknown> = {};
    for (const key of keys) {
      sorted[key] = tools[key as keyof typeof tools];
    }
    if (cachingActive && cacheTools && keys.length > 0) {
      const lastKey = keys[keys.length - 1];
      const marker = this.provider.cacheMarker(ttl, model);
      if (marker) {
        sorted[lastKey] = { ...(sorted[lastKey] as Record<string, unknown>), providerOptions: marker };
      }
    }
    return sorted as ToolMap;
  }
}
