import type { Argument, CommandUnknownOpts } from '@commander-js/extra-typings';

const DESCRIPTION_COLUMN = 42;

export interface CommandTreeNode {
  name: string;
  description: string;
  aliases: string[];
  arguments: string[];
  children: CommandTreeNode[];
}

export function walkCommandTree(command: CommandUnknownOpts): CommandTreeNode {
  return {
    name: command.name(),
    description: command.description(),
    aliases: command.aliases(),
    arguments: command.registeredArguments.map(formatArgumentDeclaration),
    children: command.commands.map((child) => walkCommandTree(child)),
  };
}

export function formatCommandTree(node: CommandTreeNode): string {
  const lines: string[] = [];
  appendNode(node, '', '', lines);
  return `${lines.join('\n')}\n`;
}

function formatArgumentDeclaration(argument: Argument): string {
  const name = `${argument.name()}${argument.variadic ? '...' : ''}`;
  return argument.required ? `<${name}>` : `[${name}]`;
}

function appendNode(node: CommandTreeNode, prefix: string, connector: string, lines: string[]): void {
  const label = formatLabel(node);
  lines.push(formatLine(`${prefix}${connector}${label}`, node.description));

  const childPrefix =
    connector === '' ? `${prefix}  ` : `${prefix}${connector === '└── ' ? '    ' : '│   '}`;
  node.children.forEach((child, index) => {
    const isLast = index === node.children.length - 1;
    const childConnector = isLast ? '└── ' : '├── ';
    appendNode(child, childPrefix, childConnector, lines);
  });
}

function formatLabel(node: CommandTreeNode): string {
  const argumentPart = node.arguments.length > 0 ? ` ${node.arguments.join(' ')}` : '';
  const aliasPart = node.aliases.length > 0 ? ` (${node.aliases.join(', ')})` : '';
  return `${node.name}${argumentPart}${aliasPart}`;
}

function formatLine(label: string, description: string): string {
  if (description.length === 0) {
    return label;
  }
  const padding = label.length >= DESCRIPTION_COLUMN ? ' ' : ' '.repeat(DESCRIPTION_COLUMN - label.length);
  return `${label}${padding}${description}`;
}
