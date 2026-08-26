import { describe, expect, it, vi } from 'vitest';
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
import type { AnalyzeResultIpc } from '../../src/server/analyze-worker-ipc.js';

const result = (recoveredPromotionOnly?: boolean): AnalyzeResultIpc => ({
  repoName: 'demo',
  repoPath: '/repos/demo',
  stats: { nodes: 10, edges: 12 },
  alreadyUpToDate: undefined,
  recoveredPromotionOnly,
  ftsRepairedOnly: undefined,
  ftsSkipped: undefined,
});
const virtualStoragePath = path.resolve('/virtual/demo', '.gitnexus');

type Listener = (...args: unknown[]) => void;

const fakeChild = (send: () => void = () => {}) => {
  const listeners = new Map<string, Listener>();
  const child = {
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
  };
  return {
    job,
    manager: {
      getJob: vi.fn(() => job),
      updateJob: vi.fn((_id: string, update: Record<string, unknown>) => {
        Object.assign(job, update);
      }),
      registerChild: vi.fn(),
    },
  };
};

const launchDeps = (
  jobManager: ReturnType<typeof fakeJobManager>['manager'],
  releaseRepoLock: ReturnType<typeof vi.fn>,
) => ({
  jobManager,
  backend: { init: vi.fn(async () => undefined) },
  acquireRepoLock: vi.fn(() => null),
  releaseRepoLock,
  closeDbHandle: vi.fn(async () => undefined),
});

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

    launch(job, '/virtual/demo', {});
    child.emit('message', { type: 'complete', result: result(true) });
    child.emit('error', new Error('late error'));
    expect(releaseRepoLock).not.toHaveBeenCalled();
    child.emit('close', 0);
    expect(releaseRepoLock).not.toHaveBeenCalled();
    finishClose();
    await vi.waitFor(() => expect(job.status).toBe('failed'));

    expect(releaseRepoLock).toHaveBeenCalledOnce();
    expect(releaseRepoLock).toHaveBeenCalledWith(virtualStoragePath);
  });

  it('keeps the lock until a cancelled worker exits', async () => {
    const { job, manager } = fakeJobManager();
    const child = fakeChild();
    launcherState.fork.mockReset().mockReturnValue(child.child);
    const releaseRepoLock = vi.fn();
    const launch = createLaunchAnalysisWorker(launchDeps(manager, releaseRepoLock));

    launch(job, '/virtual/demo', {});
    job.status = 'failed';
    child.emit('message', { type: 'error', message: 'cancelled' });
    expect(releaseRepoLock).not.toHaveBeenCalled();
    child.emit('close', 0);

    await vi.waitFor(() => expect(releaseRepoLock).toHaveBeenCalledOnce());
    expect(releaseRepoLock).toHaveBeenCalledOnce();
    expect(releaseRepoLock).toHaveBeenCalledWith(virtualStoragePath);
  });

  it('releases when terminal cleanup finishes before the worker exits', async () => {
    const { job, manager } = fakeJobManager();
    const child = fakeChild();
    launcherState.fork.mockReset().mockReturnValue(child.child);
    const releaseRepoLock = vi.fn();
    const launch = createLaunchAnalysisWorker(launchDeps(manager, releaseRepoLock));

    launch(job, '/virtual/demo', {});
    child.emit('message', { type: 'error', message: 'worker failed' });
    await vi.waitFor(() => expect(job.status).toBe('failed'));
    await Promise.resolve();
    await Promise.resolve();
    expect(releaseRepoLock).not.toHaveBeenCalled();
    child.emit('close', 1);

    expect(releaseRepoLock).toHaveBeenCalledOnce();
    expect(releaseRepoLock).toHaveBeenCalledWith(virtualStoragePath);
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
      await fs.unlink(path.join(target, '.gitnexus'));
      await fs.symlink(retargetedStorage, path.join(target, '.gitnexus'), 'dir');

      expect(deps.acquireRepoLock).toHaveBeenCalledWith(canonicalStorage);
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

  it('materializes first-analysis storage before capturing the shared lock key', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-first-analyze-lock-'));
    const repoRoot = path.join(root, 'repo');
    await fs.mkdir(repoRoot);
    try {
      const { job, manager } = fakeJobManager();
      const child = fakeChild();
      launcherState.fork.mockReset().mockReturnValue(child.child);
      const releaseRepoLock = vi.fn();
      const deps = launchDeps(manager, releaseRepoLock);

      createLaunchAnalysisWorker(deps)(job, repoRoot, {});

      const storagePath = path.join(repoRoot, '.gitnexus');
      expect((await fs.stat(storagePath)).isDirectory()).toBe(true);
      const canonicalStorage = await fs.realpath(storagePath);
      expect(deps.acquireRepoLock).toHaveBeenCalledWith(canonicalStorage);
      expect(child.child.send).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({ analyzeStoragePath: canonicalStorage }),
        }),
      );
      child.emit('message', { type: 'error', message: 'test cleanup' });
      child.emit('close', 0);
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

    launch(job, '/virtual/demo', {});
    child.emit('error', new Error('ipc failed'));

    expect(job.status).toBe('failed');
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

    launch(job, '/virtual/demo', {});

    if (_label === 'send') {
      expect(releaseRepoLock).not.toHaveBeenCalled();
      child.emit('close', 1);
      await vi.waitFor(() => expect(releaseRepoLock).toHaveBeenCalledOnce());
    } else {
      expect(releaseRepoLock).toHaveBeenCalledOnce();
    }
    expect(releaseRepoLock).toHaveBeenCalledWith(virtualStoragePath);
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

      launch(job, '/virtual/demo', {});
      first.emit('close', 1);
      vi.advanceTimersByTime(1000);
      second.emit('close', 1);
      vi.advanceTimersByTime(2000);
      third.emit('close', 1);
      await Promise.resolve();
      await Promise.resolve();

      expect(releaseRepoLock).toHaveBeenCalledOnce();
      expect(releaseRepoLock).toHaveBeenCalledWith(virtualStoragePath);
      expect(job.status).toBe('failed');
    } finally {
      vi.useRealTimers();
    }
  });
});
