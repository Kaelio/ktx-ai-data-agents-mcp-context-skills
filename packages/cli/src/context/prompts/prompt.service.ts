import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Handlebars from 'handlebars';
import { type KtxLogger, noopLogger } from '../core/index.js';

export interface PromptContext {
  current_date?: string;
  business_rules?: string;
  datasource_description?: string;
  tables_and_columns_summary?: string;
  metadata?: string;
  settings?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PromptServiceOptions {
  promptsDir: string;
  additionalPromptDirs?: string[];
  defaultSettings?: Record<string, unknown>;
  partials?: string[];
  logger?: KtxLogger;
}

export class PromptService {
  private readonly logger: KtxLogger;
  private readonly partials: string[];
  private partialsRegistered = false;

  constructor(private readonly options: PromptServiceOptions) {
    this.logger = options.logger ?? noopLogger;
    this.partials = options.partials ?? [];
    Handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);
    Handlebars.registerHelper('json', (context: unknown) => JSON.stringify(context, null, 2));
    Handlebars.registerHelper('truncate', (str: string, len: number) =>
      typeof str === 'string' && str.length > len ? `${str.substring(0, len)}...` : str,
    );
    Handlebars.registerHelper('addOne', (index: number) => index + 1);
    this.logger.log(`Prompt service initialized with directory: ${options.promptsDir}`);
  }

  private promptDirs(): string[] {
    return [this.options.promptsDir, ...(this.options.additionalPromptDirs ?? [])];
  }

  private async ensurePartials(): Promise<void> {
    if (this.partialsRegistered) {
      return;
    }
    for (const name of this.partials) {
      let registered = false;
      for (const promptsDir of this.promptDirs()) {
        try {
          const content = await readFile(join(promptsDir, `${name}.md`), 'utf-8');
          Handlebars.registerPartial(name, content);
          registered = true;
          break;
        } catch {}
      }
      if (!registered) {
        this.logger.warn(`Could not register ${name} partial`);
      }
    }
    this.partialsRegistered = true;
  }

  async loadPrompt(promptName: string, extension = 'md'): Promise<string> {
    const tried: string[] = [];
    for (const promptsDir of this.promptDirs()) {
      const promptFile = join(promptsDir, `${promptName}.${extension}`);
      tried.push(promptFile);
      try {
        const content = await readFile(promptFile, 'utf-8');
        this.logger.debug(`Loaded prompt template: ${promptName}.${extension}`);
        return content;
      } catch {}
    }

    const paths = tried.join(', ');
    this.logger.error(`Prompt file not found: ${paths}`);
    throw new Error(`Prompt file not found in any configured directory: ${paths}`);
  }

  async formatPrompt(promptName: string, context: PromptContext): Promise<string> {
    await this.ensurePartials();
    try {
      const fullContext: PromptContext = {
        current_date: context.current_date || new Date().toISOString().split('T')[0],
        business_rules: context.business_rules || '',
        ...context,
        settings: {
          ...this.options.defaultSettings,
          ...context.settings,
        },
      };

      const templateSource = await this.loadPrompt(promptName);
      const template = Handlebars.compile(templateSource, { noEscape: true });
      const rendered = template(fullContext);

      this.logger.debug(`Formatted prompt: ${promptName} (${rendered.length} chars)`);
      return rendered;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error formatting prompt ${promptName}: ${errorMessage}`);
      throw new Error(`Failed to format prompt ${promptName}: ${errorMessage}`);
    }
  }
}
