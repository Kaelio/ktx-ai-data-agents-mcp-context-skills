import { Command } from '@commander-js/extra-typings';
import { describe, expect, it } from 'vitest';
import { formatCommandTree, walkCommandTree } from './command-tree.js';

describe('walkCommandTree', () => {
  it('captures name, description, aliases, and nested children', () => {
    const root = new Command('root').description('the root');
    const child = new Command('child').description('a child').alias('c').alias('ch');
    const grandchild = new Command('grand').description('a grandchild');
    child.addCommand(grandchild);
    root.addCommand(child);

    const tree = walkCommandTree(root);

    expect(tree).toEqual({
      name: 'root',
      description: 'the root',
      aliases: [],
      arguments: [],
      children: [
        {
          name: 'child',
          description: 'a child',
          aliases: ['c', 'ch'],
          arguments: [],
          children: [{ name: 'grand', description: 'a grandchild', aliases: [], arguments: [], children: [] }],
        },
      ],
    });
  });

  it('returns an empty children array when there are no subcommands', () => {
    const leaf = new Command('leaf').description('alone');
    expect(walkCommandTree(leaf)).toEqual({
      name: 'leaf',
      description: 'alone',
      aliases: [],
      arguments: [],
      children: [],
    });
  });

  it('uses an empty string when description is unset', () => {
    const command = new Command('bare');
    expect(walkCommandTree(command).description).toBe('');
  });

  it('captures required, optional, and variadic arguments', () => {
    const command = new Command('scan')
      .argument('<connectionId>', 'KTX connection id')
      .argument('[schemas...]', 'Schemas');

    expect(walkCommandTree(command).arguments).toEqual(['<connectionId>', '[schemas...]']);
  });
});

describe('formatCommandTree', () => {
  it('renders a single node with no children', () => {
    const node = { name: 'solo', description: 'just me', aliases: [], arguments: [], children: [] };
    expect(formatCommandTree(node)).toMatch(/^solo\s+just me\n$/);
  });

  it('renders aliases in parentheses before the description', () => {
    const node = { name: 'cmd', description: 'does things', aliases: ['c', 'co'], arguments: [], children: [] };
    expect(formatCommandTree(node)).toMatch(/^cmd \(c, co\)\s+does things\n$/);
  });

  it('renders command arguments after the command name', () => {
    const node = {
      name: 'test',
      description: 'Test a configured connection',
      aliases: [],
      arguments: ['<connectionId>'],
      children: [],
    };
    expect(formatCommandTree(node)).toMatch(/^test <connectionId>\s+Test a configured connection\n$/);
  });

  it('omits the dash when description is empty', () => {
    const node = { name: 'bare', description: '', aliases: [], arguments: [], children: [] };
    expect(formatCommandTree(node)).toBe('bare\n');
  });

  it('renders tree connectors and preserves sibling registration order', () => {
    const tree = {
      name: 'root',
      description: 'top',
      aliases: [],
      arguments: [],
      children: [
        {
          name: 'beta',
          description: 'b',
          aliases: [],
          arguments: [],
          children: [{ name: 'leaf', description: 'l', aliases: [], arguments: [], children: [] }],
        },
        {
          name: 'alpha',
          description: 'a',
          aliases: ['al'],
          arguments: ['<id>'],
          children: [{ name: 'inner', description: 'i', aliases: [], arguments: [], children: [] }],
        },
      ],
    };
    const lines = formatCommandTree(tree).trimEnd().split('\n');
    expect(lines[0]).toMatch(/^root\s+top$/);
    expect(lines[1]).toMatch(/^  ├── beta\s+b$/);
    expect(lines[2]).toMatch(/^  │   └── leaf\s+l$/);
    expect(lines[3]).toMatch(/^  └── alpha <id> \(al\)\s+a$/);
    expect(lines[4]).toMatch(/^      └── inner\s+i$/);
  });
});
