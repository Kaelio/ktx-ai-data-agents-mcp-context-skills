import type { z } from 'zod';
import type { GitAuthorResolverPort } from '../../../context/tools/authors.js';
import type { ToolContext, ToolOutput } from '../../../context/tools/base-tool.js';
import { BaseTool } from '../../../context/tools/base-tool.js';
import { sourceDefinitionSchema } from '../schemas.js';
import { SemanticLayerService } from '../semantic-layer.service.js';
import { SlSearchService } from '../sl-search.service.js';

export { sourceDefinitionSchema };
// ── Shared output types ──
export interface SemanticLayerStructured {
  success: boolean;
  sourceName: string;
  yaml?: string;
  commitHash?: string;
  errors?: string[];
  validationErrors?: string[];
  validationWarnings?: string[];
  actionRequiredWarnings?: string[];
}

export interface BaseSemanticLayerToolDeps {
  semanticLayerService: SemanticLayerService;
  slSearchService: SlSearchService;
  authorResolver: GitAuthorResolverPort;
}

// ── Abstract base class ──

export abstract class BaseSemanticLayerTool<
  TInput extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
> extends BaseTool<TInput> {
  protected readonly semanticLayerService: SemanticLayerService;
  protected readonly slSearchService: SlSearchService;
  protected readonly authorResolver: GitAuthorResolverPort;

  constructor(deps: BaseSemanticLayerToolDeps) {
    super();
    this.semanticLayerService = deps.semanticLayerService;
    this.slSearchService = deps.slSearchService;
    this.authorResolver = deps.authorResolver;
  }

  protected async readSourceYaml(
    connectionId: string,
    sourceName: string,
    context?: ToolContext,
  ): Promise<string | null> {
    const semanticLayerService = context?.session?.semanticLayerService ?? this.semanticLayerService;

    const file = await semanticLayerService.readSourceFile(connectionId, sourceName);
    return file?.content ?? null;
  }

  protected buildMarkdown(
    success: boolean,
    errors: string[],
    sourceName: string,
    extra?: {
      yaml?: string;
      commitHash?: string;
      validationErrors?: string[];
      validationWarnings?: string[];
      actionRequiredWarnings?: string[];
      editCount?: number;
    },
  ): string {
    const parts: string[] = [];

    if (success) {
      const verb = extra?.editCount != null ? `applied ${extra.editCount} edit(s) to` : 'saved';
      parts.push(`Source **${sourceName}** ${verb} successfully.`);
    } else {
      parts.push(`Source **${sourceName}** update completed with ${errors.length} error(s):`);
      for (const err of errors) {
        parts.push(`- ${err}`);
      }
    }

    if (extra?.commitHash) {
      parts.push(`Commit: \`${extra.commitHash}\``);
    }

    if (extra?.actionRequiredWarnings && extra.actionRequiredWarnings.length > 0) {
      parts.push('\n**Action required:**');
      for (const warning of extra.actionRequiredWarnings) {
        parts.push(`- ${warning}`);
      }
    }

    if (extra?.validationErrors && extra.validationErrors.length > 0) {
      parts.push('\n**Validation errors:**');
      for (const ve of extra.validationErrors) {
        parts.push(`- ${ve}`);
      }
    }

    if (extra?.validationWarnings && extra.validationWarnings.length > 0) {
      parts.push('\n**Validation warnings:**');
      for (const vw of extra.validationWarnings) {
        parts.push(`- ${vw}`);
      }
    }

    if (extra?.yaml) {
      const yaml = extra.yaml;
      const MAX_YAML = 2000;
      if (yaml.length > MAX_YAML) {
        parts.push(`\n**YAML** (${yaml.length} chars, truncated):\n\`\`\`yaml\n${yaml.slice(0, MAX_YAML)}...\n\`\`\``);
      } else {
        parts.push(`\n**YAML**:\n\`\`\`yaml\n${yaml}\n\`\`\``);
      }
    }

    return parts.join('\n');
  }

  protected buildOutput(
    success: boolean,
    errors: string[],
    sourceName: string,
    extra?: {
      yaml?: string;
      commitHash?: string;
      validationErrors?: string[];
      validationWarnings?: string[];
      actionRequiredWarnings?: string[];
      editCount?: number;
    },
  ): ToolOutput<SemanticLayerStructured> {
    return {
      markdown: this.buildMarkdown(success, errors, sourceName, extra),
      structured: {
        success,
        sourceName,
        yaml: extra?.yaml,
        commitHash: extra?.commitHash,
        ...(errors.length > 0 ? { errors } : {}),
        ...(extra?.validationErrors && extra.validationErrors.length > 0
          ? { validationErrors: extra.validationErrors }
          : {}),
        ...(extra?.validationWarnings && extra.validationWarnings.length > 0
          ? { validationWarnings: extra.validationWarnings }
          : {}),
        ...(extra?.actionRequiredWarnings && extra.actionRequiredWarnings.length > 0
          ? { actionRequiredWarnings: extra.actionRequiredWarnings }
          : {}),
      },
    };
  }
}
