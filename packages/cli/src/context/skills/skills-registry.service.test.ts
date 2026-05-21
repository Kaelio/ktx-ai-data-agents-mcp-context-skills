import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillsRegistryService } from './skills-registry.service.js';

describe('SkillsRegistryService', () => {
  let service: SkillsRegistryService;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skills-registry-'));
    service = new SkillsRegistryService({ skillsDir: tempDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const writeSkill = async (dirName: string, body: string) => {
    const dir = join(tempDir, dirName);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), body, 'utf-8');
  };

  describe('parseFrontmatter', () => {
    it('parses name and description', () => {
      const frontmatter = service.parseFrontmatter('---\nname: foo\ndescription: Bar baz\n---\n\n# body');
      expect(frontmatter).toEqual({ name: 'foo', description: 'Bar baz' });
    });

    it('supports wrapped description continuation lines', () => {
      const frontmatter = service.parseFrontmatter(
        ['---', 'name: sl', 'description: Line one', '  continuation of the description.', '---', '', '# body'].join(
          '\n',
        ),
      );
      expect(frontmatter.name).toBe('sl');
      expect(frontmatter.description).toContain('Line one');
      expect(frontmatter.description).toContain('continuation');
    });

    it('returns empty fields when no frontmatter block', () => {
      expect(service.parseFrontmatter('# just a heading')).toEqual({});
    });
  });

  describe('stripFrontmatter', () => {
    it('removes the frontmatter block and leading blank line', () => {
      const body = '---\nname: x\ndescription: y\n---\n\n# Hello\n\nparagraph';
      expect(service.stripFrontmatter(body)).toBe('# Hello\n\nparagraph');
    });

    it('is a no-op when no frontmatter exists', () => {
      expect(service.stripFrontmatter('# hello')).toBe('# hello');
    });
  });

  describe('discoverSkills', () => {
    it('returns an empty map when the directory does not exist', async () => {
      const catalog = await service.discoverSkills(join(tempDir, 'missing'));
      expect(catalog.size).toBe(0);
    });

    it('discovers valid skills and skips invalid ones', async () => {
      await writeSkill('sl', '---\nname: sl\ndescription: Semantic layer.\n---\n\n# SL');
      await writeSkill('wiki_capture', '---\nname: wiki_capture\ndescription: Wiki capture.\n---\n\n# KC');
      await writeSkill('broken', '# no frontmatter at all');
      await mkdir(join(tempDir, 'not_a_skill'), { recursive: true });

      const catalog = await service.discoverSkills(tempDir);
      expect(catalog.size).toBe(2);
      expect(catalog.get('sl')?.name).toBe('sl');
      expect(catalog.get('wiki_capture')?.description).toContain('Wiki capture');
      expect(catalog.has('broken')).toBe(false);
    });
  });

  describe('buildSkillsPrompt', () => {
    it('formats bullet list with name and description', () => {
      const output = service.buildSkillsPrompt([
        { name: 'sl', description: 'Semantic layer.', path: '/tmp/sl' },
        { name: 'wiki_capture', description: 'Wiki capture.', path: '/tmp/kc' },
      ]);
      expect(output).toContain('- sl: Semantic layer.');
      expect(output).toContain('- wiki_capture: Wiki capture.');
      expect(output).toContain('Use the `load_skill` tool');
    });

    it('returns empty string when no skills are available', () => {
      expect(service.buildSkillsPrompt([])).toBe('');
    });

    it('appends the async capture note for the research caller', () => {
      const output = service.buildSkillsPrompt(
        [{ name: 'sl', description: 'Semantic layer.', path: '/tmp/sl' }],
        'research',
      );
      expect(output).toContain('captured automatically by a post-turn memory agent');
      expect(output).toContain('Focus on answering, not on saving');
    });

    it('does not append the note for memory_agent caller', () => {
      const output = service.buildSkillsPrompt(
        [{ name: 'sl_capture', description: 'Capture skill.', path: '/tmp/cap' }],
        'memory_agent',
      );
      expect(output).not.toContain('captured automatically by a post-turn memory agent');
    });
  });

  describe('parseFrontmatter callers field', () => {
    it('parses inline-array form', () => {
      const frontmatter = service.parseFrontmatter('---\nname: x\ndescription: y\ncallers: [memory_agent]\n---\n');
      expect(frontmatter.callers).toEqual(['memory_agent']);
    });

    it('parses comma-separated form', () => {
      const frontmatter = service.parseFrontmatter('---\nname: x\ndescription: y\ncallers: research, memory_agent\n---\n');
      expect(frontmatter.callers).toEqual(['research', 'memory_agent']);
    });

    it('returns undefined when callers is absent', () => {
      const frontmatter = service.parseFrontmatter('---\nname: x\ndescription: y\n---\n');
      expect(frontmatter.callers).toBeUndefined();
    });

    it('drops unknown caller names with a warning', () => {
      const frontmatter = service.parseFrontmatter('---\nname: x\ndescription: y\ncallers: [bogus, memory_agent]\n---\n');
      expect(frontmatter.callers).toEqual(['memory_agent']);
    });

    it('returns undefined when the value is empty', () => {
      const frontmatter = service.parseFrontmatter('---\nname: x\ndescription: y\ncallers:\n---\n');
      expect(frontmatter.callers).toBeUndefined();
    });
  });

  describe('listSkills and getSkill caller filter', () => {
    beforeEach(async () => {
      await writeSkill('sl', '---\nname: sl\ndescription: Open to all.\n---\n\n# SL');
      await writeSkill(
        'sl_capture',
        '---\nname: sl_capture\ndescription: Memory-only capture skill.\ncallers: [memory_agent]\n---\n\n# Capture',
      );
      await writeSkill(
        'wiki_capture',
        '---\nname: wiki_capture\ndescription: Wiki capture.\ncallers: [memory_agent]\n---\n\n# KC',
      );
      service = new SkillsRegistryService({ skillsDir: tempDir });
    });

    it('research caller sees only open skills', async () => {
      const skills = await service.listSkills('research');
      expect(skills.map((skill) => skill.name).sort()).toEqual(['sl']);
    });

    it('memory_agent caller sees memory-only and open skills', async () => {
      const skills = await service.listSkills('memory_agent');
      expect(skills.map((skill) => skill.name).sort()).toEqual(['sl', 'sl_capture', 'wiki_capture']);
    });

    it('listSkills with names and caller intersects both filters', async () => {
      const skills = await service.listSkills(['sl', 'sl_capture'], 'research');
      expect(skills.map((skill) => skill.name)).toEqual(['sl']);
    });

    it('getSkill returns null for memory-only skill when caller is research', async () => {
      const skill = await service.getSkill('sl_capture', 'research');
      expect(skill).toBeNull();
    });

    it('getSkill returns the skill when caller has access', async () => {
      const skill = await service.getSkill('sl_capture', 'memory_agent');
      expect(skill?.name).toBe('sl_capture');
    });

    it('getSkill without caller returns the skill regardless of callers field', async () => {
      const skill = await service.getSkill('sl_capture');
      expect(skill?.name).toBe('sl_capture');
    });

  });

  it('discovers skills from additional directories when the primary directory misses', async () => {
    const extraDir = await mkdtemp(join(tmpdir(), 'skills-registry-extra-'));
    try {
      await mkdir(join(extraDir, 'wiki_capture'), { recursive: true });
      await writeFile(
        join(extraDir, 'wiki_capture', 'SKILL.md'),
        [
          '---',
          'name: wiki_capture',
          'description: Packaged knowledge capture skill.',
          'callers: [memory_agent]',
          '---',
          '',
          '# Wiki Capture',
        ].join('\n'),
        'utf-8',
      );
      service = new SkillsRegistryService({ skillsDir: tempDir, additionalSkillDirs: [extraDir] });

      const skills = await service.listSkills(['wiki_capture'], 'memory_agent');

      expect(skills.map((skill) => skill.name)).toEqual(['wiki_capture']);
      expect(skills[0]?.path).toBe(join(extraDir, 'wiki_capture'));
    } finally {
      await rm(extraDir, { recursive: true, force: true });
    }
  });
});
