import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { slackPullConfigSchema, type SlackPullConfig } from '../ingest/adapters/slack/types.js';
import type { KtxProjectConnectionConfig } from '../project/config.js';

type RawKtxSlackConnectionConfig = Extract<KtxProjectConnectionConfig, { driver: 'slack' }>;

export type KtxSlackConnectionConfig = Omit<
  RawKtxSlackConnectionConfig,
  'bot_token' | 'bot_token_ref' | 'channel_ids' | 'max_messages_per_channel'
> & {
  driver: 'slack';
  bot_token: string | null;
  bot_token_ref: string | null;
  channel_ids: string[];
  max_messages_per_channel: number;
};

interface ResolveSlackTokenOptions {
  env?: Record<string, string | undefined>;
  readTextFile?: (path: string) => Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): string[] => {
    if (typeof item !== 'string') {
      return [];
    }
    const trimmed = item.trim();
    return trimmed ? [trimmed] : [];
  });
}

function integerWithFallback(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
}

function boundedInteger(value: unknown, fallback: number, name: string, min: number, max: number): number {
  const parsed = integerWithFallback(value, fallback, name);
  if (parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path;
}

export function parseSlackConnectionConfig(raw: unknown): KtxSlackConnectionConfig {
  if (!isRecord(raw)) {
    throw new Error('Slack connection config must be an object');
  }
  if (raw.driver !== 'slack') {
    throw new Error('Slack connection config requires driver: slack');
  }
  const botToken = optionalString(raw.bot_token);
  const botTokenRef = optionalString(raw.bot_token_ref);
  if (!botToken && !botTokenRef) {
    throw new Error('Slack connection config requires bot_token or bot_token_ref');
  }
  if (botTokenRef && !botTokenRef.startsWith('env:') && !botTokenRef.startsWith('file:')) {
    throw new Error('Slack bot_token_ref must use env:NAME or file:/path');
  }
  const channelIds = stringArray(raw.channel_ids);
  if (channelIds.length === 0) {
    throw new Error('Slack connection config requires at least one channel_id');
  }

  return {
    driver: 'slack',
    bot_token: botToken,
    bot_token_ref: botTokenRef,
    channel_ids: [...new Set(channelIds)].sort((left, right) => left.localeCompare(right)),
    max_messages_per_channel: boundedInteger(
      raw.max_messages_per_channel,
      1000,
      'max_messages_per_channel',
      1,
      10_000,
    ),
  };
}

/** @internal */
export async function resolveSlackBotToken(
  botTokenRef: string,
  options: ResolveSlackTokenOptions = {},
): Promise<string> {
  if (botTokenRef.startsWith('env:')) {
    const envName = botTokenRef.slice('env:'.length);
    const value = (options.env ?? process.env)[envName];
    if (!value) {
      throw new Error(`Slack token environment variable ${envName} is not set`);
    }
    return value.trim();
  }
  if (botTokenRef.startsWith('file:')) {
    const path = expandHome(botTokenRef.slice('file:'.length));
    const readTextFile = options.readTextFile ?? ((filePath: string) => readFile(filePath, 'utf-8'));
    const value = (await readTextFile(path)).trim();
    if (!value) {
      throw new Error(`Slack token file is empty: ${path}`);
    }
    return value;
  }
  throw new Error('Slack bot_token_ref must use env:NAME or file:/path');
}

export async function slackConnectionToPullConfig(
  config: KtxSlackConnectionConfig,
  options: ResolveSlackTokenOptions = {},
): Promise<SlackPullConfig> {
  const authToken = config.bot_token ?? (await resolveSlackBotToken(config.bot_token_ref ?? '', options));
  return slackPullConfigSchema.parse({
    authToken,
    channelIds: config.channel_ids,
    maxMessagesPerChannel: config.max_messages_per_channel,
  });
}
