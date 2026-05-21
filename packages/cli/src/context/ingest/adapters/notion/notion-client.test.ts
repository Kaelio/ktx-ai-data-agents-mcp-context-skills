import { describe, expect, it, vi } from 'vitest';
import { retryNotionRequest } from './notion-client.js';

describe('Notion client retry helper', () => {
  it('retries rate-limited requests and then returns the response', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const operation = vi
      .fn()
      .mockRejectedValueOnce({ code: 'rate_limited', headers: { 'retry-after': '2' } })
      .mockResolvedValueOnce({ ok: true });

    const result = await retryNotionRequest(operation, { sleep, maxAttempts: 2 });

    expect(result).toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('caps retry-after sleep from rate-limit responses', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const operation = vi
      .fn()
      .mockRejectedValueOnce({ code: 'rate_limited', headers: { 'retry-after': '3600' } })
      .mockResolvedValueOnce({ ok: true });

    await retryNotionRequest(operation, { sleep, maxAttempts: 2 });

    expect(sleep).toHaveBeenCalledWith(60_000);
  });

  it('retries transient 5xx requests and then returns the response', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const operation = vi
      .fn()
      .mockRejectedValueOnce({ code: 'service_unavailable', status: 503, message: 'temporary outage' })
      .mockResolvedValueOnce({ ok: true });

    const result = await retryNotionRequest(operation, { sleep, maxAttempts: 2 });

    expect(result).toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('uses exponential backoff for transient 5xx retries', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const operation = vi
      .fn()
      .mockRejectedValueOnce({ code: 'service_unavailable', status: 503, message: 'temporary outage' })
      .mockRejectedValueOnce({ code: 'service_unavailable', status: 503, message: 'temporary outage' })
      .mockResolvedValueOnce({ ok: true });

    await retryNotionRequest(operation, { sleep, maxAttempts: 3 });

    expect(sleep).toHaveBeenNthCalledWith(1, 1000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2000);
  });

  it('throws the sanitized error after attempts are exhausted', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const operation = vi.fn().mockRejectedValue({ code: 'rate_limited', message: 'token secret leaked' });

    await expect(retryNotionRequest(operation, { sleep, maxAttempts: 2, authToken: 'secret' })).rejects.toThrow(
      /token \*\*\* leaked/,
    );
  });
});
