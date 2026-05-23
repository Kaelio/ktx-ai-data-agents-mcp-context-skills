import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SlackWebApiClient, type SlackApi } from './slack-client.js';
import {
  SLACK_SOURCE_KEY,
  slackPullConfigSchema,
  type SlackChannelMessage,
} from './types.js';

export interface FetchSlackSnapshotParams {
  client?: SlackApi;
  config: unknown;
  stagedDir: string;
  now?: () => Date;
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value.endsWith('\n') ? value : `${value}\n`, 'utf-8');
}

function safeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function messageMarkdown(message: SlackChannelMessage): string {
  const lines = [
    `# Slack message ${message.channelId}/${message.ts}`,
    '',
    `- Channel: ${message.channelId}`,
    `- Message timestamp: ${message.ts}`,
    message.user ? `- Author: ${message.user}` : null,
    message.username ? `- Username: ${message.username}` : null,
    message.botId ? `- Bot ID: ${message.botId}` : null,
    message.subtype ? `- Subtype: ${message.subtype}` : null,
    message.threadTs ? `- Thread timestamp: ${message.threadTs}` : null,
    '',
    '## Message',
    '',
    message.text.trim().length > 0 ? message.text.trim() : '_No text content._',
  ].filter((line): line is string => line !== null);
  return `${lines.join('\n')}\n`;
}

export async function fetchSlackSnapshot(params: FetchSlackSnapshotParams): Promise<void> {
  const config = slackPullConfigSchema.parse(params.config);
  const client = params.client ?? new SlackWebApiClient(config.authToken);
  const fetchedAt = (params.now ?? (() => new Date()))().toISOString();
  let messageCount = 0;

  for (const channelId of config.channelIds) {
    const messages = await client.listChannelMessages(channelId, config.maxMessagesPerChannel);
    messageCount += messages.length;
    for (const message of messages) {
      const path = join(params.stagedDir, 'wiki', 'global', 'slack', safeSlug(channelId), `${safeSlug(message.ts)}.md`);
      await writeText(path, messageMarkdown(message));
    }
  }

  await writeText(
    join(params.stagedDir, 'manifest.json'),
    JSON.stringify(
      {
        source: SLACK_SOURCE_KEY,
        fetchedAt,
        channelIds: config.channelIds,
        maxMessagesPerChannel: config.maxMessagesPerChannel,
        messageCount,
        warnings: [],
      },
      null,
      2,
    ),
  );
}
