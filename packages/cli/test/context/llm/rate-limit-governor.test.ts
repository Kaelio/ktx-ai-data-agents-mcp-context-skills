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
});
