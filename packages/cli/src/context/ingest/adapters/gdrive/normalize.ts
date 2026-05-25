import type {
  GoogleDocsDocument,
  GoogleDocsParagraph,
  GoogleDocsParagraphElement,
  GoogleDocsStructuralElement,
} from './types.js';

function escapeMarkdownText(value: string): string {
  return value.replace(/([*_~`])/g, '\\$1');
}

function normalizeTextRun(element: GoogleDocsParagraphElement): string {
  const content = element.textRun?.content ?? '';
  const style = element.textRun?.textStyle;
  let text = escapeMarkdownText(content.replace(/\r/g, ''));
  if (!text) {
    return '';
  }
  const href = style?.link?.url?.trim();
  const isCode = style?.weightedFontFamily?.fontFamily === 'Courier New';
  if (isCode) {
    text = `\`${text.replace(/`/g, '\\`')}\``;
  }
  if (style?.bold) {
    text = `**${text}**`;
  }
  if (style?.italic) {
    text = `*${text}*`;
  }
  if (style?.strikethrough) {
    text = `~~${text}~~`;
  }
  if (href) {
    text = `[${text}](${href.replace(/\)/g, '\\)')})`;
  }
  if (style?.baselineOffset === 'SUPERSCRIPT') {
    text = `<sup>${text}</sup>`;
  } else if (style?.baselineOffset === 'SUBSCRIPT') {
    text = `<sub>${text}</sub>`;
  }
  return text;
}

function paragraphText(paragraph: GoogleDocsParagraph | undefined): string {
  return (paragraph?.elements ?? [])
    .map((element) => normalizeTextRun(element))
    .join('')
    .replace(/\n/g, '')
    .trim();
}

function headingPrefix(namedStyleType: string | undefined): string | null {
  if (!namedStyleType?.startsWith('HEADING_')) {
    return null;
  }
  const level = Number.parseInt(namedStyleType.slice('HEADING_'.length), 10);
  if (Number.isNaN(level) || level < 1) {
    return null;
  }
  return '#'.repeat(Math.min(level, 6));
}

function listPrefix(paragraph: GoogleDocsParagraph): string | null {
  if (!paragraph.bullet) {
    return null;
  }
  const level = Math.max(paragraph.bullet.nestingLevel ?? 0, 0);
  const indent = '  '.repeat(level);
  return `${indent}- `;
}

function paragraphToMarkdown(paragraph: GoogleDocsParagraph | undefined): string | null {
  const text = paragraphText(paragraph);
  if (!text) {
    return null;
  }
  const prefix = paragraph ? listPrefix(paragraph) : null;
  if (prefix) {
    return `${prefix}${text}`;
  }
  const heading = headingPrefix(paragraph?.paragraphStyle?.namedStyleType);
  if (heading) {
    return `${heading} ${text}`;
  }
  return text;
}

export function normalizeGoogleDocToMarkdown(document: GoogleDocsDocument): string {
  const lines: string[] = [];
  const content = document.body?.content ?? [];
  for (const element of content as GoogleDocsStructuralElement[]) {
    const line = paragraphToMarkdown(element.paragraph);
    if (line) {
      lines.push(line);
    }
  }
  return lines.join('\n\n').trim();
}
