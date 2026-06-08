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

describe('fetchGitHubStarCount', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it('fetches the Kaelio/ktx repository star count and unrefs the socket', async () => {
    const { socket } = mockHttpsResponse(200, JSON.stringify({ stargazers_count: 1234, name: 'ktx' }));
    const { fetchGitHubStarCount } = await import('../../src/star-prompt/star-count.js');

    await expect(fetchGitHubStarCount()).resolves.toBe(1234);

    expect(requestMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          accept: 'application/vnd.github+json',
          'user-agent': 'ktx-star-prompt',
        }),
      }),
      expect.any(Function),
    );
    const [url] = requestMock.mock.calls[0] as [URL];
    expect(url.toString()).toBe('https://api.github.com/repos/Kaelio/ktx');
    expect(socket.unref).toHaveBeenCalledTimes(1);
  });

  it('returns null for non-2xx, invalid JSON, and invalid payloads', async () => {
    const { fetchGitHubStarCount } = await import('../../src/star-prompt/star-count.js');

    mockHttpsResponse(503, 'GitHub unavailable');
    await expect(fetchGitHubStarCount()).resolves.toBeNull();

    mockHttpsResponse(200, '{bad json');
    await expect(fetchGitHubStarCount()).resolves.toBeNull();

    mockHttpsResponse(200, JSON.stringify({ stargazers_count: '1234' }));
    await expect(fetchGitHubStarCount()).resolves.toBeNull();
  });

  it('destroys the request and returns null on timeout', async () => {
    const request = new EventEmitter() as MockRequest;
    request.destroy = vi.fn();
    request.end = vi.fn();
    request.setTimeout = vi.fn((_ms: number, callback: () => void) => {
      callback();
      return request;
    });
    requestMock.mockReturnValue(request);
    const { fetchGitHubStarCount } = await import('../../src/star-prompt/star-count.js');

    await expect(fetchGitHubStarCount({ timeoutMs: 5 })).resolves.toBeNull();
    expect(request.destroy).toHaveBeenCalledWith(expect.any(Error));
  });
});
