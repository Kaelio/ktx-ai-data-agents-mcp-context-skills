import { styleText } from 'node:util';

function detectUnicodeSupport(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform !== 'win32') {
    return env.TERM !== 'linux';
  }
  return (
    Boolean(env.WT_SESSION) ||
    env.TERM_PROGRAM === 'vscode' ||
    env.TERM === 'xterm-256color' ||
    env.TERM === 'alacritty'
  );
}

const unicode = detectUnicodeSupport();

export const SYMBOLS = {
  bar: unicode ? '│' : '|',
  barStart: unicode ? '◇' : 'o',
  barEnd: unicode ? '└' : '—',
  group: unicode ? '●' : '*',
  item: unicode ? '◆' : '*',
  middot: unicode ? '·' : '-',
  emDash: unicode ? '—' : '--',
} as const;

export function dim(text: string): string {
  return styleText('dim', text);
}

export function bold(text: string): string {
  return styleText('bold', text);
}

export function gray(text: string): string {
  return styleText('gray', text);
}

export function green(text: string): string {
  return styleText('green', text);
}

export function red(text: string): string {
  return styleText('red', text);
}
