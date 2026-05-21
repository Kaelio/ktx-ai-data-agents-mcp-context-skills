import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { noopLogger, type KtxLogger } from '../../context/core/config.js';

export type SkillCaller = 'research' | 'memory_agent';

export interface SkillMetadata {
  name: string;
  description: string;
  path: string;
  callers?: SkillCaller[];
}

export interface FrontmatterFields {
  name?: string;
  description?: string;
  callers?: SkillCaller[];
}

export interface SkillsRegistryServiceOptions {
  skillsDir: string;
  additionalSkillDirs?: string[];
  logger?: KtxLogger;
}

const SKILL_FILENAME = 'SKILL.md';
const VALID_CALLERS: ReadonlySet<SkillCaller> = new Set(['research', 'memory_agent']);

export class SkillsRegistryService {
  private readonly logger: KtxLogger;
  private readonly skillsDir: string;
  private readonly additionalSkillDirs: string[];
  private catalogPromise: Promise<Map<string, SkillMetadata>> | null = null;

  constructor(options: SkillsRegistryServiceOptions) {
    this.logger = options.logger ?? noopLogger;
    this.skillsDir = options.skillsDir;
    this.additionalSkillDirs = options.additionalSkillDirs ?? [];
  }

  private async loadCatalog(): Promise<Map<string, SkillMetadata>> {
    if (!this.catalogPromise) {
      this.catalogPromise = this.discoverAllSkills();
    }
    return this.catalogPromise;
  }

  async discoverSkills(rootDir: string): Promise<Map<string, SkillMetadata>> {
    const catalog = new Map<string, SkillMetadata>();

    let entries: string[];
    try {
      entries = await readdir(rootDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Skills directory not found or unreadable at ${rootDir}: ${message}`);
      return catalog;
    }

    for (const entry of entries.sort()) {
      const dir = join(rootDir, entry);
      const skillFile = join(dir, SKILL_FILENAME);
      let isDir = false;
      try {
        isDir = (await stat(dir)).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) {
        continue;
      }

      let content: string;
      try {
        content = await readFile(skillFile, 'utf-8');
      } catch {
        this.logger.warn(`Skipping skill directory '${entry}': missing ${SKILL_FILENAME}`);
        continue;
      }

      const frontmatter = this.parseFrontmatter(content);
      if (!frontmatter.name || !frontmatter.description) {
        this.logger.warn(`Skipping skill '${entry}': frontmatter missing name or description`);
        continue;
      }

      const key = frontmatter.name.toLowerCase();
      if (catalog.has(key)) {
        this.logger.warn(`Duplicate skill name '${frontmatter.name}' in '${entry}'; first found wins`);
        continue;
      }
      catalog.set(key, {
        name: frontmatter.name,
        description: frontmatter.description,
        path: dir,
        callers: frontmatter.callers,
      });
    }

    this.logger.log(`Discovered ${catalog.size} skill(s): ${[...catalog.values()].map((skill) => skill.name).join(', ')}`);
    return catalog;
  }

  private async discoverAllSkills(): Promise<Map<string, SkillMetadata>> {
    const catalog = new Map<string, SkillMetadata>();
    for (const rootDir of [this.skillsDir, ...this.additionalSkillDirs]) {
      const discovered = await this.discoverSkills(rootDir);
      for (const [key, skill] of discovered) {
        if (!catalog.has(key)) {
          catalog.set(key, skill);
        }
      }
    }
    return catalog;
  }

  parseFrontmatter(content: string): FrontmatterFields {
    if (!content.startsWith('---')) {
      return {};
    }
    const end = content.indexOf('\n---', 3);
    if (end === -1) {
      return {};
    }

    const block = content.slice(3, end).trim();
    const fields: FrontmatterFields = {};
    let index = 0;
    const lines = block.split(/\r?\n/);
    while (index < lines.length) {
      const line = lines[index];
      const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (!match) {
        index += 1;
        continue;
      }

      const [, key, rest] = match;
      let value = rest.trim();
      const continuation: string[] = [];
      let nextIndex = index + 1;
      while (nextIndex < lines.length) {
        const next = lines[nextIndex];
        if (!next.trim() || /^[A-Za-z_][\w-]*:/.test(next) || !/^\s/.test(next)) {
          break;
        }
        continuation.push(next.trim());
        nextIndex += 1;
      }
      if (continuation.length > 0) {
        value = [value, ...continuation].filter(Boolean).join(' ');
      }
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      if (key === 'name' || key === 'description') {
        fields[key] = value;
      } else if (key === 'callers') {
        fields.callers = this.parseCallersValue(value);
      }
      index = nextIndex;
    }
    return fields;
  }

  stripFrontmatter(content: string): string {
    if (!content.startsWith('---')) {
      return content;
    }
    const end = content.indexOf('\n---', 3);
    if (end === -1) {
      return content;
    }
    return content.slice(end + 4).replace(/^(?:\r?\n)+/, '');
  }

  async listSkills(namesOrCaller?: string[] | SkillCaller, caller?: SkillCaller): Promise<SkillMetadata[]> {
    let names: string[] | undefined;
    let resolvedCaller: SkillCaller | undefined;
    if (Array.isArray(namesOrCaller)) {
      names = namesOrCaller;
      resolvedCaller = caller;
    } else if (typeof namesOrCaller === 'string') {
      resolvedCaller = namesOrCaller;
    }

    const catalog = await this.loadCatalog();
    let skills = [...catalog.values()].sort((left, right) => left.name.localeCompare(right.name));
    if (resolvedCaller) {
      skills = skills.filter((skill) => this.isAllowedFor(skill, resolvedCaller));
    }
    if (!names || names.length === 0) {
      return skills;
    }
    const requested = new Set(names.map((name) => name.toLowerCase()));
    return skills.filter((skill) => requested.has(skill.name.toLowerCase()));
  }

  async getSkill(name: string, caller?: SkillCaller): Promise<SkillMetadata | null> {
    const catalog = await this.loadCatalog();
    const skill = catalog.get(name.toLowerCase()) ?? null;
    if (!skill) {
      return null;
    }
    if (caller && !this.isAllowedFor(skill, caller)) {
      return null;
    }
    return skill;
  }

  isAllowedFor(skill: SkillMetadata, caller: SkillCaller): boolean {
    if (!skill.callers || skill.callers.length === 0) {
      return true;
    }
    return skill.callers.includes(caller);
  }

  buildSkillsPrompt(skills: SkillMetadata[], caller?: SkillCaller): string {
    if (skills.length === 0) {
      return '';
    }
    const list = skills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n');
    const captureNote =
      caller === 'research'
        ? '\n\nWiki pages and semantic-layer sources are captured automatically by a post-turn memory agent. Focus on answering, not on saving. Use `wiki_read`/`wiki_search` and `sl_read_source` to consult what already exists; the memory agent will write any new conventions or measures the turn surfaces.'
        : '';
    return `\n## Skills\n\nUse the \`load_skill\` tool to load a skill when the task benefits from specialized instructions.${captureNote}\n\nAvailable skills:\n${list}\n`;
  }

  private parseCallersValue(raw: string): SkillCaller[] | undefined {
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    const inner = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
    const parts = inner
      .split(',')
      .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    if (parts.length === 0) {
      return undefined;
    }

    const valid: SkillCaller[] = [];
    for (const part of parts) {
      if (VALID_CALLERS.has(part as SkillCaller)) {
        valid.push(part as SkillCaller);
      } else {
        this.logger.warn(`Unknown caller '${part}' in skill frontmatter; ignoring`);
      }
    }
    return valid.length > 0 ? valid : undefined;
  }
}
