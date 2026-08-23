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
  it('rejects a write after cancellation wins before its claim', async () => {
    const barrier = createEmbedCommitBarrier();
    const abort = vi.fn();
    const write = vi.fn(async () => undefined);
    expect(requestEmbedCancellation(barrier, 'cancelled', abort)).toBe('cancelled');
    await expect(
      commitEmbedMetadata(barrier, 'COMMITTING_TERMINAL', write),
    ).rejects.toThrow('cancelled');
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
    'finishes a %s commit before deferred cancellation',
    async () => {
      const barrier = createEmbedCommitBarrier();
      const blocked = blockedWrite();
      const commit = commitEmbedMetadata(barrier, 'COMMITTING_TERMINAL', blocked.write);
      expect(requestEmbedCancellation(barrier, 'cancelled', vi.fn())).toBe('deferred');
      blocked.release();
      await commit;
      expect(barrier.phase).toBe('COMPLETE');
      expect(requestEmbedCancellation(barrier, 'late', vi.fn())).toBe('terminal');
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
