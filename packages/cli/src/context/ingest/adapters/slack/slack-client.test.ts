import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlackWebApiClient } from './slack-client.js';

describe('SlackWebApiClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes allowlisted channel messages from conversations.history', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      json: async () => ({
        ok: true,
        messages: [
          {
            ts: '1768000000.000100',
            user: 'U-AUTHOR',
            text: 'Allowlisted launch rule',
            thread_ts: '1768000000.000100',
          },
        ],
        has_more: false,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(new SlackWebApiClient('xoxb-token').listChannelMessages('C123', 1000)).resolves.toEqual([
      {
        channelId: 'C123',
        ts: '1768000000.000100',
        user: 'U-AUTHOR',
        username: null,
        botId: null,
        subtype: null,
        threadTs: '1768000000.000100',
        text: 'Allowlisted launch rule',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.com/api/conversations.history',
      expect.objectContaining({
        method: 'POST',
        headers: {
          authorization: 'Bearer xoxb-token',
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel: 'C123', limit: 200 }),
      }),
    );
  });

  it('follows history cursors until maxMessages is reached', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          messages: [{ ts: '1.000001', text: 'first' }],
          has_more: true,
          response_metadata: { next_cursor: 'cursor-1' },
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          messages: [{ ts: '2.000002', text: 'second' }],
          has_more: false,
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(new SlackWebApiClient('xoxb-token').listChannelMessages('C123', 2)).resolves.toEqual([
      expect.objectContaining({ ts: '1.000001', text: 'first' }),
      expect.objectContaining({ ts: '2.000002', text: 'second' }),
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://slack.com/api/conversations.history',
      expect.objectContaining({
        body: JSON.stringify({ channel: 'C123', limit: 1, cursor: 'cursor-1' }),
      }),
    );
  });
});
