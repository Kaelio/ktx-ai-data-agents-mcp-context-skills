import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlackApi } from './slack-client.js';
import { SlackSourceAdapter } from './slack.adapter.js';

describe('SlackSourceAdapter', () => {
  let stagedDir: string;
  let client: SlackApi;
  let adapter: SlackSourceAdapter;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'slack-adapter-'));
    client = {
      listChannelMessages: vi.fn().mockResolvedValue([
        {
          channelId: 'C123',
          ts: '1768000000.000100',
          user: 'U-AUTHOR',
          username: null,
          botId: null,
          subtype: null,
          threadTs: null,
          text: 'Allowlisted launch rule',
        },
      ]),
    };
    adapter = new SlackSourceAdapter({
      client,
      now: () => new Date('2026-05-23T00:00:00.000Z'),
    });
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('declares Slack source behavior', () => {
    expect(adapter.source).toBe('slack');
    expect(adapter.skillNames).toEqual(['notion_synthesize']);
    expect(adapter.reconcileSkillNames).toEqual([]);
    expect(adapter.evidenceIndexing).toBe('documents');
    expect(adapter.triageSupported).toBe(false);
  });

  it('fetches only configured channels into wiki/global markdown', async () => {
    await adapter.fetch(
      {
        authToken: 'xoxb-token',
        channelIds: ['C123'],
        maxMessagesPerChannel: 250,
      },
      stagedDir,
      { connectionId: 'slack', sourceKey: 'slack' },
    );

    expect(client.listChannelMessages).toHaveBeenCalledWith('C123', 250);
    await expect(readFile(join(stagedDir, 'wiki/global/slack/c123/1768000000-000100.md'), 'utf-8')).resolves.toContain(
      'Allowlisted launch rule',
    );
    await expect(adapter.detect(stagedDir)).resolves.toBe(true);
  });

  it('chunks staged Slack markdown files as wiki-only work units', async () => {
    await mkdir(join(stagedDir, 'wiki/global/slack/c123'), { recursive: true });
    await writeFile(
      join(stagedDir, 'manifest.json'),
      JSON.stringify({
        source: 'slack',
        fetchedAt: '2026-05-23T00:00:00.000Z',
        channelIds: ['C123'],
        maxMessagesPerChannel: 1000,
        messageCount: 1,
        warnings: [],
      }),
      'utf-8',
    );
    await writeFile(join(stagedDir, 'wiki/global/slack/c123/1.md'), '# Slack note\n', 'utf-8');

    const result = await adapter.chunk(stagedDir);

    expect(result.workUnits).toEqual([
      expect.objectContaining({
        unitKey: 'slack-slack-c123-1',
        rawFiles: ['wiki/global/slack/c123/1.md'],
        dependencyPaths: ['manifest.json'],
      }),
    ]);
    expect(result.reconcileNotes).toContain('Slack ingest reads only configured allowlisted channels.');
  });

  it('rejects empty channel allowlists before calling Slack', async () => {
    await expect(
      adapter.fetch({ authToken: 'xoxb-token', channelIds: [] }, stagedDir, {
        connectionId: 'slack',
        sourceKey: 'slack',
      }),
    ).rejects.toThrow();
    expect(client.listChannelMessages).not.toHaveBeenCalled();
  });
});
