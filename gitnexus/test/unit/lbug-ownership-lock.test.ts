import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireLbugOwnership, closeLbug, withLbugDb } from '../../src/core/lbug/lbug-adapter.js';
import { withAnalyzeOwnershipLock } from '../../src/core/staged-promotion.js';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeLbug();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const makePaths = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-lbug-owner-'));
  roots.push(root);
  vi.stubEnv('GITNEXUS_HOME', path.join(root, 'home'));
  const storagePath = path.join(root, '.gitnexus');
  return { repoRoot: root, storagePath, lbugPath: path.join(storagePath, 'lbug') };
};

describe('Ladybug writable ownership admission', () => {
  it('does not materialize an absent storage path during storage acquisition', async () => {
    const { repoRoot, storagePath } = await makePaths();
    const lease = await acquireLbugOwnership(storagePath, repoRoot);

    await expect(lease.acquireStorage(storagePath)).rejects.toThrow(/storage path does not exist/i);
    await expect(fs.access(storagePath)).rejects.toMatchObject({ code: 'ENOENT' });

    await lease.release();
  });

  it('holds one real analyze ownership lease across separately sequenced preflight work', async () => {
    const { repoRoot, storagePath } = await makePaths();
    await expect(fs.access(storagePath)).rejects.toMatchObject({ code: 'ENOENT' });
    const lease = await acquireLbugOwnership(storagePath, repoRoot);
    await expect(fs.access(storagePath)).rejects.toMatchObject({ code: 'ENOENT' });

    await fs.mkdir(storagePath);
    await lease.acquireStorage(storagePath);
    await expect(fs.access(path.join(storagePath, 'analyze-staged.lock'))).resolves.toBeUndefined();
    await lease.attachWorker(process.pid);

    await expect(
      withAnalyzeOwnershipLock(storagePath, async () => undefined, { repoRoot }),
    ).rejects.toThrow(/another analyze is active/i);

    await lease.release();
    await lease.release();
    await expect(fs.access(path.join(storagePath, 'analyze-staged.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await expect(
      withAnalyzeOwnershipLock(storagePath, async () => 'released', { repoRoot }),
    ).resolves.toBe('released');
  });

  it('keeps the initial-lock fast path frozen to one storage target', async () => {
    const { repoRoot, storagePath } = await makePaths();
    const otherStoragePath = path.join(repoRoot, '.gitnexus-other');
    await fs.mkdir(storagePath);
    await fs.mkdir(otherStoragePath);
    const lease = await acquireLbugOwnership(storagePath, repoRoot);

    await lease.acquireStorage(storagePath);
    await lease.acquireStorage(storagePath);
    await expect(lease.acquireStorage(otherStoragePath)).rejects.toThrow(
      /already frozen to a different target/i,
    );

    await lease.release();
  });

  it('waits for an in-flight same-target storage acquisition before returning', async () => {
    const { repoRoot, storagePath } = await makePaths();
    const lease = await acquireLbugOwnership(storagePath, repoRoot);
    await fs.mkdir(storagePath);

    const firstAcquisition = lease.acquireStorage(storagePath);
    await lease.acquireStorage(storagePath);
    await lease.attachWorker(process.pid);
    await firstAcquisition;

    await lease.release();
  });

  it('does not borrow another lease when distinct companions target one new storage path', async () => {
    const { storagePath } = await makePaths();
    const firstRepoRoot = path.join(path.dirname(storagePath), 'first-repo');
    const secondRepoRoot = path.join(path.dirname(storagePath), 'second-repo');
    await fs.mkdir(firstRepoRoot);
    await fs.mkdir(secondRepoRoot);

    const first = await acquireLbugOwnership(storagePath, firstRepoRoot);
    const second = await acquireLbugOwnership(storagePath, secondRepoRoot);
    await fs.mkdir(storagePath);

    await first.acquireStorage(storagePath);
    await first.attachWorker(process.pid);
    await expect(second.acquireStorage(storagePath)).rejects.toThrow(/another analyze is active/i);

    await first.release();
    await second.acquireStorage(storagePath);
    await second.attachWorker(process.pid);
    await second.release();

    await expect(fs.access(path.join(storagePath, 'analyze-staged.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses a writable session while the real analyzer owner is active', async () => {
    const { repoRoot, storagePath, lbugPath } = await makePaths();
    let markOwned!: () => void;
    const owned = new Promise<void>((resolve) => {
      markOwned = resolve;
    });
    let releaseOwner!: () => void;
    const ownerGate = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const analyzer = withAnalyzeOwnershipLock(
      storagePath,
      async () => {
        markOwned();
        await ownerGate;
      },
      { repoRoot },
    );
    await owned;
    const operation = vi.fn(async () => undefined);

    await expect(
      withLbugDb(lbugPath, operation, {
        ownershipStoragePath: storagePath,
        ownershipRepoRoot: repoRoot,
      }),
    ).rejects.toThrow(/another analyze is active/i);
    expect(operation).not.toHaveBeenCalled();

    releaseOwner();
    await analyzer;
  });

  it.each([
    { label: 'success', failure: undefined },
    { label: 'failure', failure: 'writer failed' },
  ])('releases the real ownership lock after writable session $label', async ({ failure }) => {
    const { repoRoot, storagePath, lbugPath } = await makePaths();
    const operation = vi.fn(async () => {
      if (failure) throw new Error(failure);
      return 'complete';
    });

    const result = withLbugDb(lbugPath, operation, {
      ownershipStoragePath: storagePath,
      ownershipRepoRoot: repoRoot,
    });
    if (failure) await expect(result).rejects.toThrow(failure);
    else await expect(result).resolves.toBe('complete');
    expect(operation).toHaveBeenCalledOnce();
    await expect(
      withAnalyzeOwnershipLock(storagePath, async () => 'released', { repoRoot }),
    ).resolves.toBe('released');
  });
});
