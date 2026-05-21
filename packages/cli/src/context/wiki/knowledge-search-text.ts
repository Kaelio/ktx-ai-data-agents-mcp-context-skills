export function buildKnowledgeSearchText(blockKey: string, summary: string, content: string, tags?: string[]): string {
  const parts = [blockKey, summary, content];
  if (tags && tags.length > 0) {
    parts.push(tags.join(' '));
  }
  return parts.join('\n');
}
