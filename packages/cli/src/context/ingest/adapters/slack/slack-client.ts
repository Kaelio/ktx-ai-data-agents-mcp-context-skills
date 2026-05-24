import type { SlackChannelMessage } from './types.js';

export interface SlackApi {
  listChannelMessages(channelId: string, maxMessages: number): Promise<SlackChannelMessage[]>;
}

type SlackApiResponse = { ok?: unknown; error?: unknown };

interface SlackConversationsHistoryResponse extends SlackApiResponse {
  messages?: unknown;
  has_more?: unknown;
  response_metadata?: {
    next_cursor?: unknown;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function normalizeSlackError(method: string, payload: SlackApiResponse): Error {
  const error = typeof payload.error === 'string' && payload.error ? payload.error : 'unknown_error';
  return new Error(`Slack ${method} failed: ${error}`);
}

function headers(authToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${authToken}`,
    'content-type': 'application/json; charset=utf-8',
  };
}

export class SlackWebApiClient implements SlackApi {
  constructor(private readonly authToken: string) {}

  async listChannelMessages(channelId: string, maxMessages: number): Promise<SlackChannelMessage[]> {
    const messages: SlackChannelMessage[] = [];
    let cursor: string | null = null;

    do {
      const pageLimit = Math.max(1, Math.min(200, maxMessages - messages.length));
      const payload = await this.fetchHistoryPage(channelId, pageLimit, cursor);
      messages.push(...payload.messages);
      cursor = payload.nextCursor;
    } while (cursor && messages.length < maxMessages);

    return messages.slice(0, maxMessages);
  }

  private async fetchHistoryPage(
    channelId: string,
    limit: number,
    cursor: string | null,
  ): Promise<{ messages: SlackChannelMessage[]; nextCursor: string | null }> {
    const response = await fetch('https://slack.com/api/conversations.history', {
      method: 'POST',
      headers: headers(this.authToken),
      body: JSON.stringify({
        channel: channelId,
        limit,
        ...(cursor ? { cursor } : {}),
      }),
    });
    const payload = (await response.json()) as SlackConversationsHistoryResponse;
    if (payload.ok !== true) {
      throw normalizeSlackError('conversations.history', payload);
    }

    return {
      messages: Array.isArray(payload.messages)
        ? payload.messages.flatMap((message): SlackChannelMessage[] => {
            if (!isRecord(message)) {
              return [];
            }
            const ts = stringValue(message.ts);
            if (!ts) {
              return [];
            }
            return [
              {
                channelId,
                ts,
                user: stringValue(message.user),
                username: stringValue(message.username),
                botId: stringValue(message.bot_id),
                subtype: stringValue(message.subtype),
                threadTs: stringValue(message.thread_ts),
                text: stringValue(message.text) ?? '',
              },
            ];
          })
        : [],
      nextCursor:
        payload.has_more === true && typeof payload.response_metadata?.next_cursor === 'string'
          ? payload.response_metadata.next_cursor || null
          : null,
    };
  }
}
