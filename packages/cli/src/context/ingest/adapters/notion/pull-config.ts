import { notionPullConfigSchema, type NotionPullConfig } from './types.js';

export function parseNotionPullConfig(raw: unknown): NotionPullConfig {
  return notionPullConfigSchema.parse(raw);
}
