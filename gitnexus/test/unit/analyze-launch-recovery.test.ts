import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const launcherState = vi.hoisted(() => ({
  fork: vi.fn(),
}));

vi.mock('child_process', () => ({
  fork: (...args: unknown[]) => launcherState.fork(...args),
}));

import {
  completionUpdateForWorkerResult,
  createLaunchAnalysisWorker,
} from '../../src/server/analyze-launch.js';
import { canonicalRepoRootLockKey } from '../../src/storage/repo-manager.js';
import type { AnalyzeResultIpc } from '../../src/server/analyze-worker-ipc.js';

const result = (recoveredPromotionOnly?: boolean, alreadyUpToDate?: boolean): AnalyzeResultIpc => ({
  repoName: 'demo',
  repoPath: '/repos/demo',
  stats: { nodes: 10, edges: 12 },
  alreadyUpToDate,
  recoveredPromotionOnly,
  ftsRepairedOnly: undefined,
  ftsSkipped: undefined,
});
const virtualRepoPath = path.join(os.tmpdir(), `gitnexus-analyze-launch-${process.pid}`);
const virtualStoragePath = path.resolve(virtualRepoPath, '.gitnexus');
const virtualRootLockKey = canonicalRepoRootLockKey(virtualRepoPath);

beforeAll(async () => {
  await fs.mkdir(virtualRepoPath, { recursive: true });
});

afterAll(async () => {
  await fs.rm(virtualRepoPath, { recursive: true, force: true });
});

type Listener = (...args: unknown[]) => void;

const fakeChild = (send: () => void = () => {}) => {
  const listeners = new Map<string, Listener>();
  const child = {
    pid: 4242,
    stderr: { on: vi.fn() },
    kill: vi.fn(),
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, listener);
      return child;
    }),
    send: vi.fn(send),
  };
  return { child, emit: (event: string, ...args: unknown[]) => listeners.get(event)?.(...args) };
};

const fakeJobManager = () => {
  const job = {
    id: 'job-1',
    status: 'queued' as 'queued' | 'analyzing' | 'complete' | 'failed',
    progress: { phase: 'queued', percent: 0, message: 'queued' },
    retryCount: 0,
    cancellationReason: undefined as string | undefined,
    deferCancellationUntilCleanup: false,
  };
  return {
    job,
    manager: {
      getJob: vi.fn(() => job),
      updateJob: vi.fn((_id: string, update: Record<string, unknown>) => {
        Object.assign(job, update);
      }),
      registerChild: vi.fn(),
      deferCancellationFinalization: vi.fn(() => {
        job.deferCancellationUntilCleanup = true;
      }),
    },
  };
};

const launchDeps = (
  jobManager: ReturnType<typeof fakeJobManager>['manager'],
  releaseRepoLock: ReturnType<typeof vi.fn>,
) => {
  const ownershipRelease = vi.fn(async () => undefined);
  const acquireStorage = vi.fn(async (_storagePath: string) => undefined);
  const attachWorker = vi.fn(async (_workerPid: number) => undefined);
  return {
    jobManager,
    backend: { init: vi.fn(async () => undefined) },
    acquireRepoLock: vi.fn(() => null),
    releaseRepoLock,
    acquireAnalyzeOwnership: vi.fn(async () => ({
      acquireStorage,
      release: ownershipRelease,
      attachWorker,
    })),
    ownershipRelease,
    acquireStorage,
    attachWorker,
    closeDbHandle: vi.fn(async () => undefined),
    validateRepoDirectory: vi.fn(),
  };
};

const waitForWorkerStart = async (): Promise<void> => {
  await vi.waitFor(() => expect(launcherState.fork).toHaveBeenCalled());
};

describe('analyze worker recovery-only parent contract', () => {
  it('fails closed with retry guidance instead of reporting ordinary completion', () => {
    expect(completionUpdateForWorkerResult(result(true))).toEqual({
      status: 'failed',
      repoName: 'demo',
      error:
        'Recovered a previous staged promotion, but the current checkout was not analyzed. ' +
        'Start a new analysis with force=true and dropEmbeddings=true ' +
        '(CLI: `gitnexus analyze --staged --drop-embeddings`).',
    });
  });

  it('keeps an ordinary successful analysis complete', () => {
    expect(completionUpdateForWorkerResult(result())).toEqual({
      status: 'complete',
      repoName: 'demo',
    });
  });
});

describe('analyze worker shared lock ownership', () => {
  it('rejects a missing repository before acquiring or materializing storage', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-missing-analyze-'));
    const missingRepo = path.join(root, 'missing-repo');
    try {
      const { job, manager } = fakeJobManager();
      const releaseRepoLock = vi.fn();
      const { validateRepoDirectory: _testStub, ...deps } = launchDeps(manager, releaseRepoLock);

      createLaunchAnalysisWorker(deps)(job, missingRepo, {});

      expect(job.status).toBe('failed');
      expect(job).toMatchObject({ error: expect.stringMatching(/path does not exist/i) });
      expect(deps.acquireRepoLock).not.toHaveBeenCalled();
      expect(deps.acquireAnalyzeOwnership).not.toHaveBeenCalled();
      await expect(fs.stat(missingRepo)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not recreate a repository that disappears during ownership admission', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-disappearing-analyze-'));
    const repoRoot = path.join(root, 'repo');
    await fs.mkdir(repoRoot);
    try {
      const { job, manager } = fakeJobManager();
      const releaseRepoLock = vi.fn();
      const { validateRepoDirectory: _testStub, ...deps } = launchDeps(manager, releaseRepoLock);
      deps.acquireAnalyzeOwnership.mockImplementationOnce(async () => {
        await fs.rm(repoRoot, { recursive: true });
        return {
          acquireStorage: deps.acquireStorage,
          release: deps.ownershipRelease,
          attachWorker: deps.attachWorker,
        };
      });

      createLaunchAnalysisWorker(deps)(job, repoRoot, {});
      await vi.waitFor(() => expect(job.status).toBe('failed'));

      expect(job).toMatchObject({ error: expect.stringMatching(/path does not exist/i) });
      expect(deps.acquireStorage).not.toHaveBeenCalled();
      expect(deps.ownershipRelease).toHaveBeenCalledOnce();
      await expect(fs.stat(repoRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('attaches the worker generation before sending its start command', async () => {
    const { job, manager } = fakeJobManager();
    const child = fakeChild();
    launcherState.fork.mockReset().mockReturnValue(child.child);
    const releaseRepoLock = vi.fn();
    const deps = launchDeps(manager, releaseRepoLock);

    createLaunchAnalysisWorker(deps)(job, virtualRepoPath, {});
    await waitForWorkerStart();
    await vi.waitFor(() => expect(child.child.send).toHaveBeenCalled());

    expect(deps.acquireStorage).toHaveBeenCalledWith(virtualStoragePath);
    expect(deps.acquireStorage.mock.invocationCallOrder[0]).toBeLessThan(
      deps.attachWorker.mock.invocationCallOrder[0],
    );
    expect(deps.attachWorker).toHaveBeenCalledWith(child.child.pid);
    expect(deps.attachWorker.mock.invocationCallOrder[0]).toBeLessThan(
      child.child.send.mock.invocationCallOrder[0],
    );
    child.emit('message', { type: 'error', message: 'test cleanup' });
    child.emit('close', 0);
    await vi.waitFor(() => expect(releaseRepoLock).toHaveBeenCalledOnce());
  });

  it('does not wait for rewritten files when analysis is already up to date', async () => {
    const { job, manager } = fakeJobManager();
    const child = fakeChild();
    launcherState.fork.mockReset().mockReturnValue(child.child);
    const releaseRepoLock = vi.fn();
    const deps = launchDeps(manager, releaseRepoLock);

    createLaunchAnalysisWorker(deps)(job, virtualRepoPath, {});
    await waitForWorkerStart();
    child.emit('message', { type: 'complete', result: result(undefined, true) });
    child.emit('close', 0);

    await vi.waitFor(() => expect(job.status).toBe('complete'));
    expect(deps.closeDbHandle).toHaveBeenCalledOnce();
    expect(deps.ownershipRelease).toHaveBeenCalledOnce();
    expect(releaseRepoLock).toHaveBeenCalledOnce();
  });

  it('releases the captured key exactly once after terminal success and late events', async () => {
    const { job, manager } = fakeJobManager();
    const child = fakeChild();
    launcherState.fork.mockReset().mockReturnValue(child.child);
    const releaseRepoLock = vi.fn();
    let finishClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const deps = launchDeps(manager, releaseRepoLock);
    deps.closeDbHandle = vi.fn(() => closeGate);
    const launch = createLaunchAnalysisWorker(deps);

    launch(job, virtualRepoPath, {});
    await waitForWorkerStart();
    child.emit('message', { type: 'complete', result: result(true) });
    child.emit('error', new Error('late error'));
    expect(releaseRepoLock).not.toHaveBeenCalled();
    child.emit('close', 0);
    expect(releaseRepoLock).not.toHaveBeenCalled();
    finishClose();
    await vi.waitFor(() => expect(job.status).toBe('failed'));

    expect(releaseRepoLock).toHaveBeenCalledOnce();
    expect(releaseRepoLock).toHaveBeenCalledWith(virtualStoragePath, virtualRootLockKey);
  });

  it('publishes the terminal outcome only after the parent ownership lease releases', async () => {
    const { job, manager } = fakeJobManager();
    const child = fakeChild();
    launcherState.fork.mockReset().mockReturnValue(child.child);
    const releaseRepoLock = vi.fn();
    const deps = launchDeps(manager, releaseRepoLock);
    let finishOwnershipRelease!: () => void;
    const ownershipReleaseGate = new Promise<void>((resolve) => {
      finishOwnershipRelease = resolve;
    });
    deps.ownershipRelease.mockImplementationOnce(() => ownershipReleaseGate);

    createLaunchAnalysisWorker(deps)(job, virtualRepoPath, {});
    await waitForWorkerStart();
    child.emit('message', { type: 'complete', result: result(true) });
    child.emit('close', 0);

    await vi.waitFor(() => expect(deps.ownershipRelease).toHaveBeenCalledOnce());
    expect(job.status).toBe('analyzing');
    expect(releaseRepoLock).not.toHaveBeenCalled();

    finishOwnershipRelease();
    await vi.waitFor(() => expect(job.status).toBe('failed'));
    expect(releaseRepoLock).toHaveBeenCalledOnce();
  });

  it.each([
    { releaseError: undefined, expectedError: 'Cancelled by user' },
    {
      releaseError: 'release refused',
      expectedError: 'Cancelled by user; Analyze ownership release failed: release refused',
    },
  ])(
    'keeps successful worker completion cancelled after parent release ($releaseError)',
    async ({ releaseError, expectedError }) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-cancel-during-release-'));
      const repoRoot = path.join(root, 'repo');
      await fs.mkdir(repoRoot);
      try {
        const { job, manager } = fakeJobManager();
        const child = fakeChild();
        launcherState.fork.mockReset().mockReturnValue(child.child);
        const releaseRepoLock = vi.fn();
        const deps = launchDeps(manager, releaseRepoLock);
        let settleRelease!: () => void;
        deps.ownershipRelease.mockImplementationOnce(
          () =>
            new Promise<void>((resolve, reject) => {
              settleRelease = () =>
                releaseError ? reject(new Error(releaseError)) : resolve(undefined);
            }),
        );

        createLaunchAnalysisWorker(deps)(job, repoRoot, {});
        await waitForWorkerStart();
        const storagePath = path.join(repoRoot, '.gitnexus');
        await fs.writeFile(path.join(storagePath, 'lbug'), 'db');
        await fs.writeFile(path.join(storagePath, 'gitnexus.json'), '{}');
        child.emit('message', { type: 'complete', result: result() });
        child.emit('close', 0);
        await vi.waitFor(() => expect(deps.ownershipRelease).toHaveBeenCalledOnce());

        job.cancellationReason = 'Cancelled by user';
        settleRelease();

        await vi.waitFor(() => expect(job.status).toBe('failed'));
        expect(job).toMatchObject({ error: expectedError });
        expect(manager.updateJob).not.toHaveBeenCalledWith(
          job.id,
          expect.objectContaining({ status: 'complete' }),
        );
        expect(releaseRepoLock).toHaveBeenCalledOnce();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it('fails before successful terminal publication when ownership release fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-release-failure-'));
    const repoRoot = path.join(root, 'repo');
    await fs.mkdir(repoRoot);
    try {
      const { job, manager } = fakeJobManager();
      const child = fakeChild();
      launcherState.fork.mockReset().mockReturnValue(child.child);
      const releaseRepoLock = vi.fn();
      const deps = launchDeps(manager, releaseRepoLock);
      deps.ownershipRelease.mockRejectedValueOnce(new Error('release refused'));

      createLaunchAnalysisWorker(deps)(job, repoRoot, {});
      await waitForWorkerStart();
      const storagePath = path.join(repoRoot, '.gitnexus');
      await fs.writeFile(path.join(storagePath, 'lbug'), 'db');
      await fs.writeFile(path.join(storagePath, 'gitnexus.json'), '{}');

      child.emit('message', { type: 'complete', result: result() });
      child.emit('close', 0);

      await vi.waitFor(() => expect(job.status).toBe('failed'));
      expect(job).toMatchObject({
        status: 'failed',
        error: 'Analyze ownership release failed: release refused',
      });
      expect(manager.updateJob).not.toHaveBeenCalledWith(
        job.id,
        expect.objectContaining({ status: 'complete' }),
      );
      expect(releaseRepoLock).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the lock until a cancelled worker exits', async () => {
    const { job, manager } = fakeJobManager();
    const child = fakeChild();
    launcherState.fork.mockReset().mockReturnValue(child.child);
    const releaseRepoLock = vi.fn();
    const launch = createLaunchAnalysisWorker(launchDeps(manager, releaseRepoLock));

    launch(job, virtualRepoPath, {});
    await waitForWorkerStart();
    job.cancellationReason = 'Cancelled by user';
    child.emit('message', { type: 'error', message: 'cancelled' });
    expect(releaseRepoLock).not.toHaveBeenCalled();
    child.emit('close', 0);

    await vi.waitFor(() => expect(job.status).toBe('failed'));
    expect(job).toMatchObject({ error: 'Cancelled by user' });
    expect(releaseRepoLock).toHaveBeenCalledOnce();
    expect(releaseRepoLock).toHaveBeenCalledWith(virtualStoragePath, virtualRootLockKey);
  });

  it('publishes cancellation and ownership release failure together after child exit', async () => {
    const { job, manager } = fakeJobManager();
    const child = fakeChild();
    launcherState.fork.mockReset().mockReturnValue(child.child);
    const releaseRepoLock = vi.fn();
    const deps = launchDeps(manager, releaseRepoLock);
    deps.ownershipRelease.mockRejectedValueOnce(new Error('release refused'));

    createLaunchAnalysisWorker(deps)(job, virtualRepoPath, {});
    await waitForWorkerStart();
    job.cancellationReason = 'Cancelled by user';
    child.emit('close', 0);

    await vi.waitFor(() => expect(job.status).toBe('failed'));
    expect(job).toMatchObject({
      error: 'Cancelled by user; Analyze ownership release failed: release refused',
    });
    expect(deps.ownershipRelease).toHaveBeenCalledOnce();
    expect(releaseRepoLock).toHaveBeenCalledOnce();
  });

  it('cancels during ownership admission without starting a worker', async () => {
    const { job, manager } = fakeJobManager();
    launcherState.fork.mockReset();
    const releaseRepoLock = vi.fn();
    const deps = launchDeps(manager, releaseRepoLock);
    let admitOwnership!: () => void;
    deps.acquireAnalyzeOwnership.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          admitOwnership = () =>
            resolve({
              acquireStorage: deps.acquireStorage,
              release: deps.ownershipRelease,
              attachWorker: deps.attachWorker,
            });
        }),
    );

    createLaunchAnalysisWorker(deps)(job, virtualRepoPath, {});
    await vi.waitFor(() => expect(deps.acquireAnalyzeOwnership).toHaveBeenCalledOnce());
    job.cancellationReason = 'Cancelled by user';
    admitOwnership();

    await vi.waitFor(() => expect(job.status).toBe('failed'));
    expect(job).toMatchObject({ error: 'Cancelled by user' });
    expect(launcherState.fork).not.toHaveBeenCalled();
    expect(deps.ownershipRelease).toHaveBeenCalledOnce();
    expect(releaseRepoLock).toHaveBeenCalledOnce();
  });

  it('releases when terminal cleanup finishes before the worker exits', async () => {
    const { job, manager } = fakeJobManager();
    const child = fakeChild();
    launcherState.fork.mockReset().mockReturnValue(child.child);
    const releaseRepoLock = vi.fn();
    const launch = createLaunchAnalysisWorker(launchDeps(manager, releaseRepoLock));

    launch(job, virtualRepoPath, {});
    await waitForWorkerStart();
    child.emit('message', { type: 'error', message: 'worker failed' });
    expect(job.status).toBe('analyzing');
    await Promise.resolve();
    await Promise.resolve();
    expect(releaseRepoLock).not.toHaveBeenCalled();
    child.emit('close', 1);

    await vi.waitFor(() => expect(releaseRepoLock).toHaveBeenCalledOnce());
    expect(job.status).toBe('failed');
    expect(releaseRepoLock).toHaveBeenCalledWith(virtualStoragePath, virtualRootLockKey);
  });

  it('sends the frozen storage target when the repository storage link retargets', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-analyze-lock-'));
    const target = path.join(root, 'target');
    const storage = path.join(root, 'physical-storage');
    const retargetedStorage = path.join(root, 'retargeted-storage');
    const alias = path.join(root, 'alias');
    await fs.mkdir(target);
    await fs.mkdir(storage);
    await fs.mkdir(retargetedStorage);
    await fs.symlink(storage, path.join(target, '.gitnexus'), 'dir');
    await fs.symlink(target, alias, 'dir');
    try {
      const canonicalTarget = await fs.realpath(target);
      const canonicalStorage = await fs.realpath(storage);
      const { job, manager } = fakeJobManager();
      const child = fakeChild();
      launcherState.fork.mockReset().mockReturnValue(child.child);
      const releaseRepoLock = vi.fn();
      const deps = launchDeps(manager, releaseRepoLock);

      createLaunchAnalysisWorker(deps)(job, alias, {});
      await waitForWorkerStart();
      await fs.unlink(path.join(target, '.gitnexus'));
      await fs.symlink(retargetedStorage, path.join(target, '.gitnexus'), 'dir');

      expect(deps.acquireRepoLock).toHaveBeenNthCalledWith(1, canonicalRepoRootLockKey(alias));
      expect(deps.acquireRepoLock).toHaveBeenNthCalledWith(2, canonicalStorage);
      expect(child.child.send).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: canonicalTarget,
          options: expect.objectContaining({
            registryPath: alias,
            analyzeStoragePath: canonicalStorage,
          }),
        }),
      );
      child.emit('message', { type: 'error', message: 'test cleanup' });
      child.emit('close', 0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('acquires shared ownership before materializing first-analysis storage', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-first-analyze-lock-'));
    const repoRoot = path.join(root, 'repo');
    await fs.mkdir(repoRoot);
    try {
      launcherState.fork.mockReset();
      const { job, manager } = fakeJobManager();
      const child = fakeChild();
      launcherState.fork.mockReset().mockReturnValue(child.child);
      const releaseRepoLock = vi.fn();
      const deps = launchDeps(manager, releaseRepoLock);
      deps.acquireAnalyzeOwnership.mockImplementationOnce(async (storagePath, ownerRoot) => {
        await expect(fs.lstat(storagePath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(ownerRoot).toBe(await fs.realpath(repoRoot));
        return {
          acquireStorage: deps.acquireStorage,
          release: deps.ownershipRelease,
          attachWorker: deps.attachWorker,
        };
      });

      createLaunchAnalysisWorker(deps)(job, repoRoot, {});
      await waitForWorkerStart();

      const storagePath = path.join(repoRoot, '.gitnexus');
      expect((await fs.stat(storagePath)).isDirectory()).toBe(true);
      const canonicalRoot = await fs.realpath(repoRoot);
      const canonicalStorage = await fs.realpath(storagePath);
      expect(deps.acquireRepoLock).toHaveBeenNthCalledWith(1, canonicalRepoRootLockKey(repoRoot));
      expect(deps.acquireRepoLock).toHaveBeenNthCalledWith(2, canonicalStorage);
      expect(deps.acquireAnalyzeOwnership).toHaveBeenCalledWith(canonicalStorage, canonicalRoot);
      expect(deps.acquireStorage).toHaveBeenCalledWith(canonicalStorage);
      expect(child.child.send).toHaveBeenCalledWith(
        expect.objectContaining({
          parentAnalyzeOwnershipHeld: true,
          options: expect.objectContaining({
            analyzeStoragePath: canonicalStorage,
          }),
        }),
      );
      child.emit('message', { type: 'error', message: 'test cleanup' });
      child.emit('close', 0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('re-freezes first-analysis storage after ownership admission', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-first-analyze-retarget-'));
    const repoRoot = path.join(root, 'repo');
    const physicalStorage = path.join(root, 'physical-storage');
    const retargetedStorage = path.join(root, 'retargeted-storage');
    const lexicalStorage = path.join(repoRoot, '.gitnexus');
    await fs.mkdir(repoRoot);
    await fs.mkdir(physicalStorage);
    await fs.mkdir(retargetedStorage);
    try {
      const { job, manager } = fakeJobManager();
      const child = fakeChild();
      launcherState.fork.mockReset().mockReturnValue(child.child);
      const releaseRepoLock = vi.fn();
      const deps = launchDeps(manager, releaseRepoLock);
      deps.acquireAnalyzeOwnership.mockImplementationOnce(async (storagePath, ownerRoot) => {
        const canonicalRoot = await fs.realpath(repoRoot);
        expect(storagePath).toBe(path.join(canonicalRoot, '.gitnexus'));
        expect(ownerRoot).toBe(canonicalRoot);
        await fs.symlink(physicalStorage, lexicalStorage, 'dir');
        return {
          acquireStorage: deps.acquireStorage,
          release: deps.ownershipRelease,
          attachWorker: deps.attachWorker,
        };
      });

      createLaunchAnalysisWorker(deps)(job, repoRoot, {});
      await waitForWorkerStart();

      const canonicalStorage = await fs.realpath(physicalStorage);
      expect(deps.acquireStorage).toHaveBeenCalledWith(canonicalStorage);
      expect(deps.acquireRepoLock).toHaveBeenNthCalledWith(2, canonicalStorage);
      expect(child.child.send).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({ analyzeStoragePath: canonicalStorage }),
        }),
      );

      await fs.unlink(lexicalStorage);
      await fs.symlink(retargetedStorage, lexicalStorage, 'dir');
      child.emit('message', { type: 'error', message: 'test cleanup' });
      child.emit('close', 0);
      await vi.waitFor(() => expect(releaseRepoLock).toHaveBeenCalledOnce());
      expect(releaseRepoLock).toHaveBeenCalledWith(
        canonicalStorage,
        canonicalRepoRootLockKey(repoRoot),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a delete-held root key before materializing first-analysis storage', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-delete-first-lock-'));
    const repoRoot = path.join(root, 'repo');
    await fs.mkdir(repoRoot);
    try {
      launcherState.fork.mockReset();
      const { job, manager } = fakeJobManager();
      const releaseRepoLock = vi.fn();
      const deps = launchDeps(manager, releaseRepoLock);
      deps.acquireRepoLock.mockImplementationOnce(
        () => 'Another job is already active for this repository',
      );

      createLaunchAnalysisWorker(deps)(job, repoRoot, {});

      expect(deps.acquireRepoLock).toHaveBeenCalledOnce();
      expect(deps.acquireRepoLock).toHaveBeenCalledWith(canonicalRepoRootLockKey(repoRoot));
      await expect(fs.lstat(path.join(repoRoot, '.gitnexus'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(job.status).toBe('failed');
      expect(launcherState.fork).not.toHaveBeenCalled();
      expect(releaseRepoLock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('retains the lock after a child error until close proves termination', async () => {
    const { job, manager } = fakeJobManager();
    const child = fakeChild();
    launcherState.fork.mockReset().mockReturnValue(child.child);
    const releaseRepoLock = vi.fn();
    const launch = createLaunchAnalysisWorker(launchDeps(manager, releaseRepoLock));

    launch(job, virtualRepoPath, {});
    await waitForWorkerStart();
    child.emit('error', new Error('ipc failed'));

    expect(job.status).toBe('analyzing');
    expect(child.child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(releaseRepoLock).not.toHaveBeenCalled();
    child.emit('close', 1);
    await vi.waitFor(() => expect(releaseRepoLock).toHaveBeenCalledOnce());
  });

  it.each([
    [
      'fork',
      () => {
        throw new Error('fork failed');
      },
    ],
    [
      'send',
      () => {
        throw new Error('send failed');
      },
    ],
  ])('cleans up synchronously when %s throws', async (_label, failure) => {
    const { job, manager } = fakeJobManager();
    const releaseRepoLock = vi.fn();
    const child = fakeChild(failure);
    launcherState.fork.mockReset().mockImplementation(() => {
      if (_label === 'fork') throw new Error('fork failed');
      return child.child;
    });
    const launch = createLaunchAnalysisWorker(launchDeps(manager, releaseRepoLock));

    launch(job, virtualRepoPath, {});

    if (_label === 'send') {
      await waitForWorkerStart();
      expect(releaseRepoLock).not.toHaveBeenCalled();
      child.emit('close', 1);
      await vi.waitFor(() => expect(releaseRepoLock).toHaveBeenCalledOnce());
    } else {
      await vi.waitFor(() => expect(releaseRepoLock).toHaveBeenCalledOnce());
    }
    expect(releaseRepoLock).toHaveBeenCalledWith(virtualStoragePath, virtualRootLockKey);
    expect(job.status).toBe('failed');
    if (_label === 'send') expect(child.child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('keeps the lock through retries and releases once when retries are exhausted', async () => {
    vi.useFakeTimers();
    try {
      const { job, manager } = fakeJobManager();
      const first = fakeChild();
      const second = fakeChild();
      const third = fakeChild();
      launcherState.fork
        .mockReset()
        .mockReturnValueOnce(first.child)
        .mockReturnValueOnce(second.child)
        .mockReturnValueOnce(third.child);
      const releaseRepoLock = vi.fn();
      const launch = createLaunchAnalysisWorker(launchDeps(manager, releaseRepoLock));

      launch(job, virtualRepoPath, {});
      await waitForWorkerStart();
      first.emit('close', 1);
      vi.advanceTimersByTime(1000);
      second.emit('close', 1);
      vi.advanceTimersByTime(2000);
      third.emit('close', 1);
      await vi.runAllTimersAsync();

      expect(releaseRepoLock).toHaveBeenCalledOnce();
      expect(releaseRepoLock).toHaveBeenCalledWith(virtualStoragePath, virtualRootLockKey);
      expect(job.status).toBe('failed');
    } finally {
      vi.useRealTimers();
    }
  });
});
