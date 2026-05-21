import type { NotionBlock, NotionMetadata, NotionObjectType, NotionRichText } from './types.js';

function richTextToMarkdown(value: unknown): string {
  if (!Array.isArray(value)) {
    return '';
  }
  return value
    .map((part) => {
      const text = typeof (part as NotionRichText).plain_text === 'string' ? (part as NotionRichText).plain_text : '';
      const href = typeof (part as NotionRichText).href === 'string' ? (part as NotionRichText).href : null;
      return href && text ? `[${text}](${href.replace(/\)/g, '\\)')})` : text;
    })
    .join('')
    .trim();
}

/** @internal */
export function propertyValueToText(value: unknown): string {
  if (!value || typeof value !== 'object' || !('type' in value)) {
    return '';
  }
  const property = value as Record<string, unknown>;
  switch (property.type) {
    case 'title':
      return richTextToMarkdown((property.title as unknown[]) ?? []);
    case 'rich_text':
      return richTextToMarkdown((property.rich_text as unknown[]) ?? []);
    case 'select':
      return typeof (property.select as { name?: unknown } | null)?.name === 'string'
        ? (property.select as { name: string }).name
        : '';
    case 'multi_select':
      return Array.isArray(property.multi_select)
        ? property.multi_select
            .map((item) =>
              typeof (item as { name?: unknown }).name === 'string' ? (item as { name: string }).name : '',
            )
            .filter(Boolean)
            .join(', ')
        : '';
    case 'checkbox':
      return String(Boolean(property.checkbox));
    case 'date':
      return typeof (property.date as { start?: unknown } | null)?.start === 'string'
        ? (property.date as { start: string }).start
        : '';
    case 'number':
      return property.number === null || property.number === undefined ? '' : String(property.number);
    case 'url':
    case 'email':
    case 'phone_number':
      return typeof property[property.type as string] === 'string' ? String(property[property.type as string]) : '';
    default:
      return '';
  }
}

function extractTitle(properties: Record<string, unknown>): string {
  for (const value of Object.values(properties)) {
    if (value && typeof value === 'object' && (value as { type?: unknown }).type === 'title') {
      const title = propertyValueToText(value);
      if (title) {
        return title;
      }
    }
  }
  return 'Untitled';
}

function parentId(parent: unknown): string | null {
  if (!parent || typeof parent !== 'object') {
    return null;
  }
  const typed = parent as Record<string, unknown>;
  if (typed.type === 'page_id' && typeof typed.page_id === 'string') {
    return typed.page_id;
  }
  if (typed.type === 'database_id' && typeof typed.database_id === 'string') {
    return typed.database_id;
  }
  if (typed.type === 'data_source_id' && typeof typed.data_source_id === 'string') {
    return typed.data_source_id;
  }
  return null;
}

function editorName(user: unknown): string | null {
  if (!user || typeof user !== 'object') {
    return null;
  }
  const typed = user as Record<string, unknown>;
  if (typeof typed.name === 'string') {
    return typed.name;
  }
  return null;
}

export function normalizeNotionPageMetadata(input: {
  page: Record<string, unknown>;
  fallbackPath: string[];
  objectType: NotionObjectType;
  databaseId?: string | null;
  dataSourceId?: string | null;
}): NotionMetadata {
  const properties =
    input.page.properties && typeof input.page.properties === 'object'
      ? (input.page.properties as Record<string, unknown>)
      : {};
  const title = extractTitle(properties);
  const selectedProperties = Object.fromEntries(
    Object.entries(properties)
      .filter(([, value]) => value && typeof value === 'object' && (value as { type?: unknown }).type !== 'title')
      .map(([key, value]) => [key, propertyValueToText(value)])
      .filter(([, value]) => value !== ''),
  );

  return {
    objectType: input.objectType,
    id: String(input.page.id),
    title,
    path: [...input.fallbackPath, title].filter(Boolean).join(' / '),
    url: typeof input.page.url === 'string' ? input.page.url : null,
    parentId: parentId(input.page.parent),
    databaseId: input.databaseId ?? null,
    dataSourceId: input.dataSourceId ?? null,
    lastEditedAt: typeof input.page.last_edited_time === 'string' ? input.page.last_edited_time : null,
    lastEditedBy: editorName(input.page.last_edited_by),
    properties: selectedProperties,
  };
}

export function normalizeNotionBlocksToMarkdown(blocks: NotionBlock[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    const payload = block[block.type] as Record<string, unknown> | undefined;
    const text = richTextToMarkdown(payload?.rich_text);
    switch (block.type) {
      case 'heading_1':
        lines.push(`## ${text}`);
        break;
      case 'heading_2':
        lines.push(`### ${text}`);
        break;
      case 'heading_3':
        lines.push(`#### ${text}`);
        break;
      case 'paragraph':
        if (text) {
          lines.push(text);
        }
        break;
      case 'bulleted_list_item':
        lines.push(`- ${text}`);
        break;
      case 'numbered_list_item':
        lines.push(`1. ${text}`);
        break;
      case 'to_do':
        lines.push(`- [${payload?.checked ? 'x' : ' '}] ${text}`);
        break;
      case 'quote':
        lines.push(`> ${text}`);
        break;
      case 'callout':
        lines.push(`> ${text}`);
        break;
      case 'code':
        lines.push(`\`\`\`${typeof payload?.language === 'string' ? payload.language : ''}\n${text}\n\`\`\``);
        break;
      case 'divider':
        lines.push('---');
        break;
      case 'child_page':
        if (typeof payload?.title === 'string') {
          lines.push(`- Child page: ${payload.title}`);
        }
        break;
      default:
        if (text) {
          lines.push(text);
        }
        break;
    }
  }
  return lines.join('\n\n').trim();
}
