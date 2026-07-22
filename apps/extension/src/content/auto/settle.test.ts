import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { settle, SETTLE_MAX_MS } from './settle.js';

describe('settle (spec §6.5)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function watch(promise: Promise<{ settled: boolean }>) {
    const state = { resolved: false, value: undefined as { settled: boolean } | undefined };
    void promise.then((v) => {
      state.resolved = true;
      state.value = v;
    });
    return state;
  }

  it('resolves settled:true after 400ms of quiet with no in-flight requests', async () => {
    const state = watch(settle({ inFlightRequests: () => 0 }));
    await vi.advanceTimersByTimeAsync(500);
    expect(state.resolved).toBe(true);
    expect(state.value).toEqual({ settled: true });
  });

  it('a DOM mutation resets the quiet window', async () => {
    const state = watch(settle({ inFlightRequests: () => 0 }));
    await vi.advanceTimersByTimeAsync(300);
    document.body.appendChild(document.createElement('div'));
    await vi.advanceTimersByTimeAsync(200); // 500ms total, but only ~200ms quiet
    expect(state.resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(300); // quiet reaches 400ms
    expect(state.value).toEqual({ settled: true });
  });

  it('mutations inside our own overlay are ignored', async () => {
    const overlay = document.createElement('div');
    overlay.setAttribute('data-openqa-ignore', 'true');
    document.body.appendChild(overlay);
    await vi.advanceTimersByTimeAsync(10);

    const state = watch(settle({ inFlightRequests: () => 0 }));
    await vi.advanceTimersByTimeAsync(300);
    overlay.appendChild(document.createElement('span')); // must NOT reset quiet
    await vi.advanceTimersByTimeAsync(150);
    expect(state.value).toEqual({ settled: true });
  });

  it('in-flight requests block settling until the timeout', async () => {
    const state = watch(settle({ inFlightRequests: () => 1 }));
    await vi.advanceTimersByTimeAsync(SETTLE_MAX_MS - 100);
    expect(state.resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(state.value).toEqual({ settled: false });
  });

  it('continuous mutations hit the hard cap with settled:false (not an error)', async () => {
    const keepMutating = setInterval(() => {
      document.body.appendChild(document.createElement('i'));
    }, 100);
    const state = watch(settle({ inFlightRequests: () => 0 }));
    await vi.advanceTimersByTimeAsync(SETTLE_MAX_MS + 200);
    clearInterval(keepMutating);
    expect(state.value).toEqual({ settled: false });
  });
});
