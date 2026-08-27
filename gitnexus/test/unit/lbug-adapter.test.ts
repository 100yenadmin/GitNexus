import { describe, expect, it, vi } from 'vitest';
import {
  fetchExistingEmbeddingHashes,
  fetchExistingEmbeddingHashesForNodeIds,
} from '../../src/core/lbug/lbug-adapter.js';

describe('shared schema-error callers', () => {
  it('propagates a connection does-not-exist failure from the full hash scan', async () => {
    const execQuery = vi.fn().mockRejectedValue(new Error('connection does not exist'));

    await expect(fetchExistingEmbeddingHashes(execQuery)).rejects.toThrow(
      'connection does not exist',
    );
    expect(execQuery).toHaveBeenCalledOnce();
  });

  it('propagates a connection not-found failure from the bounded hash scan', async () => {
    const execQuery = vi.fn().mockRejectedValue(new Error('connection not found'));

    await expect(fetchExistingEmbeddingHashesForNodeIds(execQuery, ['node-1'])).rejects.toThrow(
      'connection not found',
    );
    expect(execQuery).toHaveBeenCalledOnce();
  });
});
