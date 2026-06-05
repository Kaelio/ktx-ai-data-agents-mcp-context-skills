import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.hoisted(() => vi.fn());

vi.mock('node:https', () => ({
  request: requestMock,
}));

type MockResponse = EventEmitter & { statusCode?: number };
type MockRequest = EventEmitter & {
  destroy: ReturnType<typeof vi.fn>;
  end: () => void;
  setTimeout: ReturnType<typeof vi.fn>;
};

function mockHttpsResponse(statusCode: number, body: string): { socket: { unref: ReturnType<typeof vi.fn> } } {
  const socket = { unref: vi.fn() };
  requestMock.mockImplementation((_url: unknown, _options: unknown, callback: (response: MockResponse) => void) => {
    const request = new EventEmitter() as MockRequest;
    request.destroy = vi.fn();
    request.setTimeout = vi.fn();
    request.end = () => {
      request.emit('socket', socket);
      const response = new EventEmitter() as MockResponse;
      response.statusCode = statusCode;
      callback(response);
      response.emit('data', Buffer.from(body));
      response.emit('end');
    };
    return request;
  });
  return { socket };
}

describe('fetchDistTags', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it('fetches @kaelio/ktx npm dist-tags and unrefs the socket', async () => {
    const { socket } = mockHttpsResponse(200, JSON.stringify({ latest: '0.10.0', next: '0.11.0-rc.1' }));
    const { fetchDistTags } = await import('../../src/update-check/registry.js');

    await expect(fetchDistTags()).resolves.toEqual({ latest: '0.10.0', next: '0.11.0-rc.1' });

    expect(requestMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ accept: 'application/json' }),
      }),
      expect.any(Function),
    );
    const [url] = requestMock.mock.calls[0] as [URL];
    expect(url.toString()).toBe('https://registry.npmjs.org/-/package/@kaelio/ktx/dist-tags');
    expect(socket.unref).toHaveBeenCalledTimes(1);
  });

  it('rejects non-2xx responses', async () => {
    mockHttpsResponse(503, 'registry unavailable');
    const { fetchDistTags } = await import('../../src/update-check/registry.js');

    await expect(fetchDistTags()).rejects.toThrow('npm dist-tags request failed with 503');
  });

  it('rejects invalid JSON payloads', async () => {
    mockHttpsResponse(200, '{bad json');
    const { fetchDistTags } = await import('../../src/update-check/registry.js');

    await expect(fetchDistTags()).rejects.toThrow();
  });

  it('rejects payloads that are not string dist-tag maps', async () => {
    mockHttpsResponse(200, JSON.stringify({ latest: 123 }));
    const { fetchDistTags } = await import('../../src/update-check/registry.js');

    await expect(fetchDistTags()).rejects.toThrow();
  });
});
