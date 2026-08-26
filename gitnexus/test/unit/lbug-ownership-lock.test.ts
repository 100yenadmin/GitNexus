import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeLbug, withLbugDb } from '../../src/core/lbug/lbug-adapter.js';
import { withAnalyzeOwnershipLock } from '../../src/core/staged-promotion.js';

const roots: string[] = [];

afterEach(async () => {
  await closeLbug();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const makePaths = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-lbug-owner-'));
  roots.push(root);
  const storagePath = path.join(root, '.gitnexus');
  return { storagePath, lbugPath: path.join(storagePath, 'lbug') };
};

describe('Ladybug writable ownership admission', () => {
  it('refuses a writable session while the real analyzer owner is active', async () => {
    const { storagePath, lbugPath } = await makePaths();
    let markOwned!: () => void;
    const owned = new Promise<void>((resolve) => {
      markOwned = resolve;
    });
    let releaseOwner!: () => void;
    const ownerGate = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const analyzer = withAnalyzeOwnershipLock(storagePath, async () => {
      markOwned();
      await ownerGate;
    });
    await owned;
    const operation = vi.fn(async () => undefined);

    await expect(
      withLbugDb(lbugPath, operation, { ownershipStoragePath: storagePath }),
    ).rejects.toThrow(/another analyze is active/i);
    expect(operation).not.toHaveBeenCalled();

    releaseOwner();
    await analyzer;
  });

  it.each([
    { label: 'success', failure: undefined },
    { label: 'failure', failure: 'writer failed' },
  ])('releases the real ownership lock after writable session $label', async ({ failure }) => {
    const { storagePath, lbugPath } = await makePaths();
    const operation = vi.fn(async () => {
      if (failure) throw new Error(failure);
      return 'complete';
    });

    const result = withLbugDb(lbugPath, operation, { ownershipStoragePath: storagePath });
    if (failure) await expect(result).rejects.toThrow(failure);
    else await expect(result).resolves.toBe('complete');
    expect(operation).toHaveBeenCalledOnce();
    await expect(withAnalyzeOwnershipLock(storagePath, async () => 'released')).resolves.toBe(
      'released',
    );
  });
});
