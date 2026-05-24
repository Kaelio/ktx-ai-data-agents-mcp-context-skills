import { z } from 'zod';

export const SLACK_SOURCE_KEY = 'slack';

export const slackPullConfigSchema = z.object({
  authToken: z.string().min(1),
  channelIds: z.array(z.string().min(1)).min(1),
  maxMessagesPerChannel: z.number().int().min(1).max(10_000).default(1000),
});
export type SlackPullConfig = z.infer<typeof slackPullConfigSchema>;

export const slackManifestSchema = z.object({
  source: z.literal(SLACK_SOURCE_KEY),
  fetchedAt: z.string().datetime(),
  channelIds: z.array(z.string()),
  maxMessagesPerChannel: z.number().int().min(1),
  messageCount: z.number().int().min(0),
  warnings: z.array(z.string()).default([]),
});

export interface SlackChannelMessage {
  channelId: string;
  ts: string;
  user: string | null;
  username: string | null;
  botId: string | null;
  subtype: string | null;
  threadTs: string | null;
  text: string;
}
