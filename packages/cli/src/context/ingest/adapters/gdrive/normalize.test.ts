import { describe, expect, it } from 'vitest';
import { normalizeGoogleDocToMarkdown } from './normalize.js';

describe('normalizeGoogleDocToMarkdown', () => {
  it('converts headings, lists, links, and inline formatting', () => {
    const markdown = normalizeGoogleDocToMarkdown({
      title: 'Ops Handbook',
      body: {
        content: [
          {
            paragraph: {
              paragraphStyle: { namedStyleType: 'HEADING_1' },
              elements: [{ textRun: { content: 'Policy' } }],
            },
          },
          {
            paragraph: {
              elements: [
                { textRun: { content: 'Use ' } },
                { textRun: { content: 'documented', textStyle: { bold: true } } },
                { textRun: { content: ' rules.' } },
              ],
            },
          },
          {
            paragraph: {
              bullet: { nestingLevel: 0 },
              elements: [{ textRun: { content: 'First item' } }],
            },
          },
          {
            paragraph: {
              bullet: { nestingLevel: 1 },
              elements: [{ textRun: { content: 'Nested item' } }],
            },
          },
          {
            paragraph: {
              elements: [
                {
                  textRun: {
                    content: 'Reference',
                    textStyle: { link: { url: 'https://example.com/docs)' }, italic: true },
                  },
                },
              ],
            },
          },
        ],
      },
    });

    expect(markdown).toContain('# Policy');
    expect(markdown).toContain('Use **documented** rules.');
    expect(markdown).toContain('- First item');
    expect(markdown).toContain('  - Nested item');
    expect(markdown).toContain('[*Reference*](https://example.com/docs\\))');
  });
});
