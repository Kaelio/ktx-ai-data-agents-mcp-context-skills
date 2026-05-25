import { describe, expect, it } from 'vitest';
import { normalizeNotionBlocksToMarkdown, normalizeNotionPageMetadata, propertyValueToText } from '../../../../../src/context/ingest/adapters/notion/normalize.js';

describe('Notion normalization', () => {
  it('converts common blocks into stable markdown', () => {
    const markdown = normalizeNotionBlocksToMarkdown([
      { id: 'h1', type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'Policy' }] } },
      { id: 'p1', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Booked revenue excludes refunds.' }] } },
      { id: 'b1', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'Exclude tests' }] } },
      { id: 'n1', type: 'numbered_list_item', numbered_list_item: { rich_text: [{ plain_text: 'Review monthly' }] } },
      { id: 't1', type: 'to_do', to_do: { checked: true, rich_text: [{ plain_text: 'Approved by Finance' }] } },
      { id: 'c1', type: 'code', code: { language: 'sql', rich_text: [{ plain_text: 'select 1' }] } },
    ]);

    expect(markdown).toContain('## Policy');
    expect(markdown).toContain('Booked revenue excludes refunds.');
    expect(markdown).toContain('- Exclude tests');
    expect(markdown).toContain('1. Review monthly');
    expect(markdown).toContain('- [x] Approved by Finance');
    expect(markdown).toContain('```sql\nselect 1\n```');
  });

  it('escapes closing parens in markdown link URLs', () => {
    const markdown = normalizeNotionBlocksToMarkdown([
      {
        id: 'p1',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ plain_text: 'Disambiguation', href: 'https://example.com/wiki/Foo_(bar)' }],
        },
      },
    ]);

    expect(markdown).toBe(String.raw`[Disambiguation](https://example.com/wiki/Foo_(bar\))`);
  });

  it('normalizes title, path, parent, editor, and properties', () => {
    const metadata = normalizeNotionPageMetadata({
      page: {
        id: 'page-1',
        url: 'https://notion.so/page-1',
        parent: { type: 'page_id', page_id: 'parent-1' },
        last_edited_time: '2026-04-12T10:15:00.000Z',
        last_edited_by: { type: 'person', name: 'Jane Doe', person: {} },
        properties: {
          Name: { type: 'title', title: [{ plain_text: 'Revenue Recognition' }] },
          Status: { type: 'select', select: { name: 'Approved' } },
        },
      },
      fallbackPath: ['Company Handbook', 'Finance'],
      objectType: 'page',
    });

    expect(metadata).toMatchObject({
      objectType: 'page',
      id: 'page-1',
      title: 'Revenue Recognition',
      path: 'Company Handbook / Finance / Revenue Recognition',
      parentId: 'parent-1',
      lastEditedAt: '2026-04-12T10:15:00.000Z',
      lastEditedBy: 'Jane Doe',
      properties: { Status: 'Approved' },
    });
  });

  it('formats selected property values for search text', () => {
    expect(propertyValueToText({ type: 'multi_select', multi_select: [{ name: 'Finance' }, { name: 'Policy' }] })).toBe(
      'Finance, Policy',
    );
    expect(propertyValueToText({ type: 'checkbox', checkbox: true })).toBe('true');
    expect(propertyValueToText({ type: 'date', date: { start: '2026-04-01', end: null } })).toBe('2026-04-01');
  });
});
