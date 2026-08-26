import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ownership = vi.hoisted(() => ({
  withAnalyzeOwnershipLock: vi.fn(),
}));

vi.mock('../../src/core/staged-promotion.js', () => ({
  withAnalyzeOwnershipLock: ownership.withAnalyzeOwnershipLock,
}));

import { closeLbug, withLbugDb } from '../../src/core/lbug/lbug-adapter.js';

describe('Ladybug writable ownership admission', () => {
  beforeEach(() => {
    ownership.withAnalyzeOwnershipLock.mockReset();
  });

  it.each([
    { label: 'success', failure: undefined },
    { label: 'failure', failure: 'writer failed' },
  ])(
    'retains ownership through writable session $label and releases afterward',
    async ({ failure }) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-lbug-owner-'));
      const storagePath = path.join(root, '.gitnexus');
      const lbugPath = path.join(storagePath, 'lbug');
      let ownershipActive = false;
      ownership.withAnalyzeOwnershipLock.mockImplementationOnce(async (ownedPath, callback) => {
        expect(ownedPath).toBe(storagePath);
        ownershipActive = true;
        try {
          return await callback();
        } finally {
          ownershipActive = false;
        }
      });
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let releaseOperation!: () => void;
      const operationGate = new Promise<void>((resolve) => {
        releaseOperation = resolve;
      });
      const operation = vi.fn(async () => {
        markStarted();
        await operationGate;
        if (failure) throw new Error(failure);
        return 'complete';
      });

      try {
        let settled = false;
        const result = withLbugDb(lbugPath, operation, {
          ownershipStoragePath: storagePath,
        }).finally(() => {
          settled = true;
        });
        await started;
        expect(ownershipActive).toBe(true);
        expect(settled).toBe(false);
        releaseOperation();
        if (failure) await expect(result).rejects.toThrow(failure);
        else await expect(result).resolves.toBe('complete');
        expect(ownershipActive).toBe(false);
        expect(ownership.withAnalyzeOwnershipLock).toHaveBeenCalledOnce();
        expect(operation).toHaveBeenCalledOnce();
      } finally {
        releaseOperation?.();
        await closeLbug();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
