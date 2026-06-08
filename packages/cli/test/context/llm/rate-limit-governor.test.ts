import { describe, expect, it } from 'vitest';
import {
  createRateLimitGovernorConfig,
  RateLimitGovernor,
  type RateLimitWaitState,
} from '../../../src/context/llm/rate-limit-governor.js';

function testClock(startMs = 1_000) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

async function flushMicrotasks(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

describe('RateLimitGovernor', () => {
  it('drops and restores the effective work-unit limit from warning signals', () => {
    const clock = testClock();
    const states: RateLimitWaitState[] = [];
    const governor = new RateLimitGovernor(
      createRateLimitGovernorConfig({ maxConcurrency: 6, minConcurrencyUnderPressure: 1 }),
      { now: clock.now, sleep: async () => undefined, random: () => 0 },
    );
    governor.subscribe((state) => states.push(state));

    expect(governor.currentLimit()).toBe(6);
    governor.report({
      provider: 'claude-subscription',
      status: 'warning',
      utilization: 0.91,
      rateLimitType: 'five_hour',
    });
    expect(governor.currentLimit()).toBe(1);
    governor.report({
      provider: 'claude-subscription',
      status: 'allowed',
      utilization: 0.2,
      rateLimitType: 'five_hour',
    });
    expect(governor.currentLimit()).toBe(6);
    expect(states.map((state) => state.kind)).toContain('concurrency_adjusted');
  });

  it('blocks work slots during a rejected reset window and emits wait states', async () => {
    const clock = testClock();
    const states: RateLimitWaitState[] = [];
    const sleeps: number[] = [];
    const governor = new RateLimitGovernor(
      createRateLimitGovernorConfig({ maxConcurrency: 2, waitStateTickMs: 100 }),
      {
        now: clock.now,
        random: () => 0,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock.advance(ms);
        },
      },
    );
    governor.subscribe((state) => states.push(state));

    governor.report({ provider: 'anthropic-api', status: 'rejected', retryAfterMs: 250, rateLimitType: 'rpm' });
    const release = await governor.acquireWorkSlot();
    release();

    expect(sleeps).toEqual([100, 100, 50]);
    expect(states.some((state) => state.kind === 'wait_started' && state.provider === 'anthropic-api')).toBe(true);
    expect(states.some((state) => state.kind === 'wait_finished' && state.provider === 'anthropic-api')).toBe(true);
  });

  it('rejects an interrupted wait without consuming a work slot', async () => {
    const clock = testClock();
    let abortListener: (() => void) | undefined;
    const governor = new RateLimitGovernor(
      createRateLimitGovernorConfig({ maxConcurrency: 1, waitStateTickMs: 100 }),
      {
        now: clock.now,
        random: () => 0,
        sleep: async (_ms, signal) =>
          new Promise<void>((_resolve, reject) => {
            abortListener = () => reject(new DOMException('Aborted', 'AbortError'));
            signal?.addEventListener('abort', abortListener, { once: true });
          }),
      },
    );
    const controller = new AbortController();

    governor.report({
      provider: 'claude-subscription',
      status: 'rejected',
      resetAtMs: 2_000,
      rateLimitType: 'five_hour',
    });
    const pending = governor.acquireWorkSlot(controller.signal);
    controller.abort();
    abortListener?.();

    await expect(pending).rejects.toThrow(/Aborted/);
    expect(governor.activeSlots()).toBe(0);
  });

  it('rejects an already-aborted ready wait', async () => {
    const governor = new RateLimitGovernor(
      createRateLimitGovernorConfig({ maxConcurrency: 1 }),
      { sleep: async () => undefined, random: () => 0 },
    );
    const controller = new AbortController();
    controller.abort();

    await expect(governor.waitForReady(controller.signal)).rejects.toThrow(/Aborted/);
  });

  it('rejects an already-aborted work slot without consuming capacity', async () => {
    const governor = new RateLimitGovernor(
      createRateLimitGovernorConfig({ maxConcurrency: 1 }),
      { sleep: async () => undefined, random: () => 0 },
    );
    const controller = new AbortController();
    controller.abort();

    await expect(governor.acquireWorkSlot(controller.signal)).rejects.toThrow(/Aborted/);
    expect(governor.activeSlots()).toBe(0);
  });

  it('uses bounded opaque backoff for rejected signals without reset hints', async () => {
    const clock = testClock();
    const sleeps: number[] = [];
    const governor = new RateLimitGovernor(
      createRateLimitGovernorConfig({
        maxConcurrency: 1,
        retry: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 60_000, jitter: false },
      }),
      {
        now: clock.now,
        random: () => 0,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock.advance(ms);
        },
      },
    );

    governor.report({ provider: 'codex', status: 'rejected', rateLimitType: 'opaque' });
    const release1 = await governor.acquireWorkSlot();
    release1();
    governor.report({ provider: 'codex', status: 'rejected', rateLimitType: 'opaque' });
    const release2 = await governor.acquireWorkSlot();
    release2();

    expect(sleeps).toEqual([1_000, 2_000]);
  });

  it('exposes the configured retry budget and disables outer retries when pacing is off', () => {
    const retry = { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 60_000, jitter: false };
    const enabled = new RateLimitGovernor(createRateLimitGovernorConfig({ retry }));
    expect(enabled.maxRetryAttempts()).toBe(3);

    const disabled = new RateLimitGovernor(createRateLimitGovernorConfig({ enabled: false, retry }));
    expect(disabled.maxRetryAttempts()).toBe(1);
  });

  it('emits visible wait ticks after a rejected report without a waiting caller', async () => {
    const clock = testClock();
    const states: RateLimitWaitState[] = [];
    const sleeps: number[] = [];
    const governor = new RateLimitGovernor(
      createRateLimitGovernorConfig({ maxConcurrency: 4, minConcurrencyUnderPressure: 1, waitStateTickMs: 100 }),
      {
        now: clock.now,
        random: () => 0,
        sleep: async (ms, signal) => {
          if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }
          sleeps.push(ms);
          clock.advance(ms);
        },
      },
    );
    governor.subscribe((state) => states.push(state));

    governor.report({
      provider: 'claude-subscription',
      status: 'rejected',
      resetAtMs: 1_250,
      rateLimitType: 'five_hour',
    });
    await flushMicrotasks();

    expect(sleeps).toEqual([100, 100, 50]);
    expect(states).toContainEqual(
      expect.objectContaining({
        kind: 'wait_started',
        provider: 'claude-subscription',
        rateLimitType: 'five_hour',
        remainingMs: 250,
      }),
    );
    expect(states.filter((state) => state.kind === 'wait_tick')).toHaveLength(3);
    expect(states).toContainEqual(
      expect.objectContaining({
        kind: 'wait_finished',
        provider: 'claude-subscription',
        rateLimitType: 'five_hour',
        remainingMs: 0,
      }),
    );
  });

  it('does not duplicate countdown sleeps when a work slot waits during the same pause', async () => {
    const clock = testClock();
    const states: RateLimitWaitState[] = [];
    const sleeps: number[] = [];
    const governor = new RateLimitGovernor(
      createRateLimitGovernorConfig({ maxConcurrency: 2, waitStateTickMs: 100 }),
      {
        now: clock.now,
        random: () => 0,
        sleep: async (ms, signal) => {
          if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }
          sleeps.push(ms);
          clock.advance(ms);
        },
      },
    );
    governor.subscribe((state) => states.push(state));

    governor.report({ provider: 'anthropic-api', status: 'rejected', retryAfterMs: 250, rateLimitType: 'rpm' });
    const pendingRelease = governor.acquireWorkSlot();
    await flushMicrotasks();
    const release = await pendingRelease;
    release();

    expect(sleeps).toEqual([100, 100, 50]);
    expect(states.filter((state) => state.kind === 'wait_tick')).toHaveLength(3);
    expect(governor.activeSlots()).toBe(0);
  });

  it('stops the visible wait ticker when the last subscriber unsubscribes', async () => {
    const clock = testClock();
    let abortCount = 0;
    const governor = new RateLimitGovernor(
      createRateLimitGovernorConfig({ maxConcurrency: 1, waitStateTickMs: 100 }),
      {
        now: clock.now,
        random: () => 0,
        sleep: async (_ms, signal) =>
          new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => {
                abortCount += 1;
                reject(new DOMException('Aborted', 'AbortError'));
              },
              { once: true },
            );
          }),
      },
    );
    const unsubscribe = governor.subscribe(() => undefined);

    governor.report({ provider: 'claude-subscription', status: 'rejected', retryAfterMs: 1_000 });
    await flushMicrotasks(1);
    unsubscribe();
    await flushMicrotasks(1);

    expect(abortCount).toBe(1);
  });
});
