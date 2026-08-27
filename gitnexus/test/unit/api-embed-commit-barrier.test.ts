import { describe, expect, it, vi } from 'vitest';
import {
  commitEmbedMetadata,
  createEmbedCommitBarrier,
  requestEmbedCancellation,
} from '../../src/server/api.js';

const blockedWrite = () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  return { release, write: vi.fn(() => pending) };
};

describe('/api/embed metadata commit barrier', () => {
  it.each([
    ['RUNNING', 'Embedding timed out', 'Cancelled by user', 'cancelled', 'terminal', 1],
    ['RUNNING', 'Cancelled by user', 'Embedding timed out', 'cancelled', 'terminal', 1],
    [
      'COMMITTING_CHECKPOINT',
      'Embedding timed out',
      'Cancelled by user',
      'deferred',
      'deferred',
      2,
    ],
    [
      'COMMITTING_CHECKPOINT',
      'Cancelled by user',
      'Embedding timed out',
      'deferred',
      'deferred',
      2,
    ],
    ['COMMITTING_TERMINAL', 'Embedding timed out', 'Cancelled by user', 'deferred', 'deferred', 0],
    ['COMMITTING_TERMINAL', 'Cancelled by user', 'Embedding timed out', 'deferred', 'deferred', 0],
  ] as const)(
    'latches the first reason in %s for %s then %s',
    (phase, firstReason, secondReason, firstOutcome, secondOutcome, abortCalls) => {
      const barrier = createEmbedCommitBarrier();
      barrier.phase = phase;
      const abort = vi.fn();

      expect(requestEmbedCancellation(barrier, firstReason, abort)).toBe(firstOutcome);
      expect(requestEmbedCancellation(barrier, secondReason, abort)).toBe(secondOutcome);

      expect(barrier.cancelRequested).toBe(true);
      expect(barrier.cancelReason).toBe(firstReason);
      expect(abort).toHaveBeenCalledTimes(abortCalls);
    },
  );

  it('rejects a write after cancellation wins before its claim', async () => {
    const barrier = createEmbedCommitBarrier();
    const abort = vi.fn();
    const write = vi.fn(async () => undefined);
    expect(requestEmbedCancellation(barrier, 'cancelled', abort)).toBe('cancelled');
    await expect(commitEmbedMetadata(barrier, 'COMMITTING_TERMINAL', write)).rejects.toThrow(
      'cancelled',
    );
    expect(write).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledOnce();
    expect(barrier.phase).toBe('FAILED');
  });

  it('preserves a checkpoint when cancellation arrives during its commit', async () => {
    const barrier = createEmbedCommitBarrier();
    const blocked = blockedWrite();
    const commit = commitEmbedMetadata(barrier, 'COMMITTING_CHECKPOINT', blocked.write);
    expect(requestEmbedCancellation(barrier, 'cancelled', vi.fn())).toBe('deferred');
    blocked.release();
    await expect(commit).rejects.toThrow('cancelled');
    expect(blocked.write).toHaveBeenCalledOnce();
    expect(barrier.phase).toBe('FAILED');
  });

  it.each(['empty graph', 'terminal'])(
    'holds a %s terminal claim through deferred cancellation',
    async () => {
      const barrier = createEmbedCommitBarrier();
      const blocked = blockedWrite();
      const commit = commitEmbedMetadata(barrier, 'COMMITTING_TERMINAL', blocked.write);
      expect(requestEmbedCancellation(barrier, 'cancelled', vi.fn())).toBe('deferred');
      blocked.release();
      await commit;
      expect(barrier.phase).toBe('COMMITTING_TERMINAL');
      expect(requestEmbedCancellation(barrier, 'late', vi.fn())).toBe('deferred');
    },
  );

  it('fails closed on save failure and timeout uses the same claim', async () => {
    const barrier = createEmbedCommitBarrier();
    await expect(
      commitEmbedMetadata(barrier, 'COMMITTING_CHECKPOINT', async () => {
        throw new Error('save failed');
      }),
    ).rejects.toThrow('save failed');
    expect(barrier.phase).toBe('FAILED');

    const timedOut = createEmbedCommitBarrier();
    const abort = vi.fn();
    expect(requestEmbedCancellation(timedOut, 'Embedding timed out', abort)).toBe('cancelled');
    expect(abort).toHaveBeenCalledOnce();
    expect(timedOut.cancelReason).toBe('Embedding timed out');
  });
});
