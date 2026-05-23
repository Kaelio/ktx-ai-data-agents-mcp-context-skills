import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSlackConnectionConfig, resolveSlackBotToken, slackConnectionToPullConfig } from './slack-config.js';

describe('standalone Slack connection config', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-slack-config-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('parses Slack config with a required channel allowlist', () => {
    expect(
      parseSlackConnectionConfig({
        driver: 'slack',
        bot_token_ref: 'env:SLACK_BOT_TOKEN',
        channel_ids: ['C2', 'C1', 'C1'],
        max_messages_per_channel: 25,
      }),
    ).toEqual({
      driver: 'slack',
      bot_token: null,
      bot_token_ref: 'env:SLACK_BOT_TOKEN',
      channel_ids: ['C1', 'C2'],
      max_messages_per_channel: 25,
    });
  });

  it('rejects Slack config without channels', () => {
    expect(() =>
      parseSlackConnectionConfig({
        driver: 'slack',
        bot_token_ref: 'env:SLACK_BOT_TOKEN',
        channel_ids: [],
      }),
    ).toThrow('Slack connection config requires at least one channel_id');
  });

  it('resolves Slack env and file token references', async () => {
    const tokenPath = join(tempDir, 'slack-token.txt');
    await writeFile(tokenPath, 'xoxb-file-token\n', 'utf-8');

    await expect(resolveSlackBotToken('env:SLACK_BOT_TOKEN', { env: { SLACK_BOT_TOKEN: 'xoxb-env-token' } })).resolves.toBe(
      'xoxb-env-token',
    );
    await expect(resolveSlackBotToken(`file:${tokenPath}`)).resolves.toBe('xoxb-file-token');
  });

  it('converts Slack config into adapter pull config', async () => {
    await expect(
      slackConnectionToPullConfig(
        parseSlackConnectionConfig({
          driver: 'slack',
          bot_token_ref: 'env:SLACK_BOT_TOKEN',
          channel_ids: ['C1'],
        }),
        { env: { SLACK_BOT_TOKEN: 'xoxb-env-token' } },
      ),
    ).resolves.toEqual({
      authToken: 'xoxb-env-token',
      channelIds: ['C1'],
      maxMessagesPerChannel: 1000,
    });
  });
});
