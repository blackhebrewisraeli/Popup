// @vitest-environment node

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The finance worker's reply protocol: every request gets exactly one `{ id, result }` or
 * `{ id, error }`, whether its work fails synchronously (computation, cache) or asynchronously
 * (a saved-file check). Failures here are controlled stand-ins, not real data.
 */
vi.mock('@/lib/savedScanFile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/savedScanFile')>();
  return { ...actual, checkSavedScanFile: vi.fn(actual.checkSavedScanFile) };
});

import { FinanceCache, handleFinanceRequest, type FinanceRequest } from '@/lib/financeCompute';
import { checkSavedScanFile } from '@/lib/savedScanFile';

const posted = vi.fn();
const scope: { onmessage: ((event: MessageEvent) => void) | null; postMessage: typeof posted } = {
  onmessage: null,
  postMessage: posted,
};

beforeAll(async () => {
  vi.stubGlobal('self', scope);
  await import('@/lib/finance.worker');
});
afterEach(() => {
  vi.restoreAllMocks();
  posted.mockClear();
});

const SMA: FinanceRequest = { kind: 'sma', values: [1, 2, 3, 4, 5], period: 3 };

/** Delivers one message to the worker; a synchronous throw here is the bug under test. */
const send = (id: number, request: FinanceRequest) =>
  scope.onmessage?.({ data: { id, request } } as MessageEvent);

const cacheFailure = () =>
  vi.spyOn(FinanceCache.prototype, 'get').mockImplementationOnce(() => {
    throw new Error('synthetic cache failure');
  });

describe('handleFinanceRequest', () => {
  it('turns a synchronous computation or cache failure into a rejected promise', async () => {
    cacheFailure();
    let returned: Promise<unknown> | undefined;
    expect(() => {
      returned = handleFinanceRequest(SMA, new FinanceCache());
    }).not.toThrow();
    await expect(returned).rejects.toThrow('synthetic cache failure');
  });

  it('still answers with the cached result and leaves saved files uncached', async () => {
    const cache = new FinanceCache();
    const first = await handleFinanceRequest(SMA, cache);
    expect(await handleFinanceRequest(SMA, cache)).toBe(first);
    expect(cache.size).toBe(1);
    vi.mocked(checkSavedScanFile).mockResolvedValueOnce({
      state: 'MALFORMED',
      reason: 'synthetic',
      scanId: null,
    });
    await handleFinanceRequest({ kind: 'savedScanFile', bytes: new ArrayBuffer(1) }, cache);
    expect(cache.size).toBe(1);
  });
});

describe('the finance worker', () => {
  it('sends an error with the request ID when the work fails synchronously', async () => {
    cacheFailure();
    expect(() => send(41, SMA)).not.toThrow();
    await vi.waitFor(() => expect(posted).toHaveBeenCalledTimes(1));
    expect(posted).toHaveBeenCalledWith({ id: 41, error: 'synthetic cache failure' });
  });

  it('sends the same error protocol when a saved-file check rejects', async () => {
    vi.mocked(checkSavedScanFile).mockRejectedValueOnce(new Error('synthetic file failure'));
    send(42, { kind: 'savedScanFile', bytes: new ArrayBuffer(1) });
    await vi.waitFor(() => expect(posted).toHaveBeenCalledTimes(1));
    expect(posted).toHaveBeenCalledWith({ id: 42, error: 'synthetic file failure' });
  });

  it('answers the next valid request after a failed one', async () => {
    cacheFailure();
    send(43, SMA);
    send(44, SMA);
    await vi.waitFor(() => expect(posted).toHaveBeenCalledTimes(2));
    expect(posted).toHaveBeenCalledWith({ id: 43, error: 'synthetic cache failure' });
    const answer = posted.mock.calls.find(([message]) => message.id === 44)?.[0];
    expect(Array.from(answer.result as Float64Array)).toEqual([NaN, NaN, 2, 3, 4]);
  });
});
