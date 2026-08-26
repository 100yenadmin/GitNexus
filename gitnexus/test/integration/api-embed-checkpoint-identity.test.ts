import http from 'node:http';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingIntegrityReport } from '../../src/core/lbug/lbug-adapter.js';
import {
  canonicalizePath,
  canonicalRepoLockKey,
  canonicalRepoRootLockKey,
  type RegistryEntry,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { escapeCypherString } from '../../src/core/lbug/cypher-escape.js';
import { JobManager } from '../../src/server/analyze-job.js';
import { withAnalyzeOwnershipLock } from '../../src/core/staged-promotion.js';

const MODEL = 'api-checkpoint-test-model';
const LIVE_DIGEST = 'a'.repeat(64);
const MISMATCHED_DIGEST = 'b'.repeat(64);
const REPO: RegistryEntry = {
  name: 'checkpoint-fixture',
  path: '/virtual/checkpoint-fixture',
  storagePath: '/virtual/checkpoint-fixture/.gitnexus',
  indexedAt: '2026-08-22T00:00:00.000Z',
  lastCommit: 'test-head',
};

const identity = { provider: 'api-checkpoint-test-provider', model: MODEL, dimensions: 384 };
const makeIntegrity = (digest: string, physicalRows = 3): EmbeddingIntegrityReport => ({
  tablePresent: true,
  physicalRows,
  validRows: physicalRows,
  recoverableRows: physicalRows,
  emptyIdRows: 0,
  emptyNodeIdRows: 0,
  invalidChunkRows: 0,
  noncanonicalIdRows: 0,
  duplicateIdRows: 0,
  duplicateSemanticRows: 0,
  orphanRows: 0,
  wrongDimensionRows: 0,
  recoverableIdentitySha256: digest,
});

const makeMeta = (digest: string, repoPath = REPO.path, zeroCheckpoint = false): RepoMeta => ({
  repoPath,
  lastCommit: REPO.lastCommit,
  indexedAt: REPO.indexedAt,
  stats: { embeddings: 3 },
  embeddingCheckpoint: {
    at: REPO.indexedAt,
    nodesProcessed: zeroCheckpoint ? 0 : 1,
    totalNodes: zeroCheckpoint ? 0 : 2,
    chunksProcessed: 3,
    ...identity,
    provider: zeroCheckpoint ? undefined : identity.provider,
    physicalRows: zeroCheckpoint ? undefined : 3,
    validRows: zeroCheckpoint ? undefined : 3,
    recoverableIdentitySha256: zeroCheckpoint ? undefined : digest,
    pendingNodeIds: [],
  },
});

const state = {
  currentMeta: makeMeta(MISMATCHED_DIGEST),
  liveIntegrity: makeIntegrity(LIVE_DIGEST),
  graphNodes: [{ id: 'node-1' }],
  executeQuery: vi.fn(async () => state.graphNodes),
  openModes: [] as Array<boolean | undefined>,
  openOwnershipPaths: [] as Array<string | undefined>,
  openOwnershipRepoRoots: [] as Array<string | undefined>,
  ownershipGate: undefined as Promise<void> | undefined,
  releaseOwnershipLease: vi.fn(async () => undefined),
  acquireLbugOwnership: vi.fn(async (storagePath: string, repoRoot: string) => {
    state.openOwnershipPaths.push(storagePath);
    state.openOwnershipRepoRoots.push(repoRoot);
    return { release: state.releaseOwnershipLease };
  }),
  closeLbug: vi.fn(async () => undefined),
  withLbugReadOnlyNonRecovering: vi.fn((_dbPath: string, operation: () => Promise<unknown>) => {
    state.openModes.push(true);
    return operation().finally(() => state.closeLbug());
  }),
  withLbugDb: vi.fn(
    async (
      _dbPath: string,
      operation: () => Promise<unknown>,
      options?: {
        readOnly?: boolean;
        ownershipStoragePath?: string;
        ownershipRepoRoot?: string;
      },
    ) => {
      state.openModes.push(options?.readOnly);
      if (options?.ownershipStoragePath) {
        state.openOwnershipPaths.push(options.ownershipStoragePath);
        state.openOwnershipRepoRoots.push(options.ownershipRepoRoot);
      }
      if (state.ownershipGate) await state.ownershipGate;
      return operation();
    },
  ),
  runEmbeddingPipeline: vi.fn(async (..._args: unknown[]) => undefined),
  getActiveEmbeddingIdentity: vi.fn(() => identity),
  inspectEmbeddingIntegrity: vi.fn(async () => state.liveIntegrity),
  getStrictLbugStats: vi.fn(async () => ({ nodes: 4, edges: 5 })),
  registerRepo: vi.fn(
    async (
      _repoPath?: string,
      _meta?: RepoMeta,
      options?: {
        commitReceipt?: {
          value?: { previousOwner: RegistryEntry | null; committedOwner: RegistryEntry };
        };
      },
    ) => {
      if (options?.commitReceipt) {
        options.commitReceipt.value = { previousOwner: REPO, committedOwner: REPO };
      }
      return REPO.name;
    },
  ),
  rollbackRegistryCommit: vi.fn(async () => undefined),
  unregisterRepo: vi.fn(async () => undefined),
  saveMeta: vi.fn(async (_storagePath: string, next: RepoMeta) => {
    state.currentMeta = next;
  }),
  loadMeta: vi.fn(async () => state.currentMeta),
  listRegisteredRepos: vi.fn(async () => [REPO]),
  deleteHandlerStarted: undefined as (() => void) | undefined,
  releaseAnalyzeLock: undefined as (() => void) | undefined,
  afterSafeStorageValidation: undefined as (() => void) | undefined,
};

const armDeleteHandlerSignal = (): Promise<void> =>
  new Promise((resolve) => {
    state.deleteHandlerStarted = () => {
      state.deleteHandlerStarted = undefined;
      resolve();
    };
  });

const prepareSymlinkRace = async (prefix: string) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const targetA = path.join(root, 'canonical-a');
  const targetB = path.join(root, 'canonical-b');
  const alias = path.join(root, 'repo-alias');
  await Promise.all([
    fs.mkdir(path.join(targetA, '.gitnexus'), { recursive: true }),
    fs.mkdir(path.join(targetB, '.gitnexus'), { recursive: true }),
  ]);
  await fs.symlink(targetA, alias, 'dir');
  const raceRepo = { ...REPO, path: alias, storagePath: path.join(alias, '.gitnexus') };
  state.currentMeta = makeMeta(LIVE_DIGEST, alias, true);
  Object.assign(state, { liveIntegrity: makeIntegrity(LIVE_DIGEST, 0), graphNodes: [] });
  return {
    root,
    alias,
    raceRepo,
    retarget: async () => {
      await fs.unlink(alias);
      await fs.symlink(targetB, alias, 'dir');
    },
  };
};

vi.doMock('../../src/storage/repo-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/storage/repo-manager.js')>(
    '../../src/storage/repo-manager.js',
  );
  return {
    ...actual,
    listRegisteredRepos: state.listRegisteredRepos,
    loadMeta: state.loadMeta,
    registerRepo: state.registerRepo,
    rollbackRegistryCommit: state.rollbackRegistryCommit,
    unregisterRepo: state.unregisterRepo,
    saveMeta: state.saveMeta,
    assertSafeStoragePath: (entry: RegistryEntry) => {
      actual.assertSafeStoragePath(entry);
      state.afterSafeStorageValidation?.();
    },
  };
});

vi.doMock('../../src/core/lbug/lbug-adapter.js', async () => ({
  ...(await vi.importActual<typeof import('../../src/core/lbug/lbug-adapter.js')>(
    '../../src/core/lbug/lbug-adapter.js',
  )),
  executeQuery: state.executeQuery,
  executePrepared: vi.fn(async () => []),
  executeWithReusedStatement: vi.fn(async () => undefined),
  streamQuery: vi.fn(async () => undefined),
  flushWAL: vi.fn(async () => undefined),
  closeLbug: state.closeLbug,
  acquireLbugOwnership: state.acquireLbugOwnership,
  withLbugReadOnlyNonRecovering: state.withLbugReadOnlyNonRecovering,
  withLbugDb: state.withLbugDb,
  isReadOnlyDbError: vi.fn(() => false),
  queryFTS: vi.fn(async () => []),
  inspectEmbeddingIntegrity: state.inspectEmbeddingIntegrity,
  getStrictLbugStats: state.getStrictLbugStats,
  embeddingIntegrityFailures: vi.fn(() => 0),
  fetchExistingEmbeddingHashes: vi.fn(async () => undefined),
}));

vi.doMock('../../src/core/embeddings/embedder.js', () => ({
  getActiveEmbeddingIdentity: state.getActiveEmbeddingIdentity,
}));
vi.doMock('../../src/core/embeddings/embedding-pipeline.js', () => ({
  runEmbeddingPipeline: state.runEmbeddingPipeline,
}));
vi.doMock('../../src/mcp/local/local-backend.js', () => ({
  LocalBackend: class {
    async init(): Promise<void> {}
    async disconnect(): Promise<void> {}
  },
}));
vi.doMock('../../src/server/mcp-http.js', () => ({
  mountMCPEndpoints: () => async (): Promise<void> => {},
}));
vi.doMock('../../src/server/analyze-launch.js', () => ({
  createLaunchAnalysisWorker:
    (deps: {
      acquireRepoLock: (...keys: string[]) => string | null;
      releaseRepoLock: (...keys: string[]) => void;
      jobManager: JobManager;
    }) =>
    (job: { id: string }, targetPath: string): void => {
      const rootKey = canonicalRepoRootLockKey(targetPath);
      const rootLockError = deps.acquireRepoLock(rootKey);
      if (rootLockError) {
        deps.jobManager.updateJob(job.id, { status: 'failed', error: rootLockError });
        return;
      }
      const storageKey = canonicalRepoLockKey(targetPath);
      const storageLockError = deps.acquireRepoLock(storageKey);
      if (storageLockError) {
        deps.releaseRepoLock(rootKey);
        deps.jobManager.updateJob(job.id, { status: 'failed', error: storageLockError });
        return;
      }
      deps.jobManager.updateJob(job.id, { status: 'analyzing' });
      state.releaseAnalyzeLock = () => {
        deps.releaseRepoLock(storageKey, rootKey);
        deps.jobManager.updateJob(job.id, { status: 'failed', error: 'test cleanup' });
      };
    },
}));
vi.doMock('../../src/server/analyze-upload.js', () => ({
  createAnalyzeUploadHandler: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.doMock('../../src/server/upload-sweep.js', () => ({
  sweepStaleUploads: async (): Promise<void> => {},
}));

vi.doMock('../../src/server/validation.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/server/validation.js')>(
    '../../src/server/validation.js',
  );
  return {
    ...actual,
    createRouteLimiter: (opts?: { limit?: number }) =>
      opts?.limit === 20
        ? (_req: unknown, _res: unknown, next: () => void) => next()
        : actual.createRouteLimiter(opts),
  };
});

const allocatePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        reject(new Error('could not allocate a test port'));
        return;
      }
      probe.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });

const waitForTerminalJob = async (baseUrl: string, jobId: string) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${baseUrl}/api/embed/${jobId}`);
    const body = (await response.json()) as { status: string; error?: string };
    if (body.status === 'complete' || body.status === 'failed') return body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`embedding job ${jobId} did not reach a terminal state`);
};

const runEmbedJob = async (baseUrl: string, repo: string) => {
  const response = await fetch(`${baseUrl}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo }),
  });
  const { jobId } = (await response.json()) as { jobId: string };
  return waitForTerminalJob(baseUrl, jobId);
};

const runSymlinkRace = async (
  baseUrl: string,
  fixture: Awaited<ReturnType<typeof prepareSymlinkRace>>,
  error: RegExp,
  assertSpecific: () => void,
): Promise<void> => {
  try {
    const checkpointBefore = JSON.stringify(state.currentMeta.embeddingCheckpoint);
    const job = await runEmbedJob(baseUrl, fixture.raceRepo.name);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(error);
    assertSpecific();
    expect(state.saveMeta).not.toHaveBeenCalled();
    expect(JSON.stringify(state.currentMeta.embeddingCheckpoint)).toBe(checkpointBefore);
    expect(state.currentMeta.repoPath).toBe(fixture.alias);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
};

describe('canonical repository lock keys', () => {
  it('captures the symlink target before the repository disappears', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-lock-key-'));
    const target = path.join(root, 'real-repo');
    const alias = path.join(root, 'repo-alias');
    await fs.mkdir(path.join(target, '.gitnexus'), { recursive: true });
    await fs.symlink(target, alias, 'dir');

    try {
      const canonicalTarget = await fs.realpath(target);
      const captured = canonicalRepoLockKey(alias);
      expect(captured).toBe(path.join(canonicalTarget, '.gitnexus'));

      await fs.rm(target, { recursive: true, force: true });

      // A recomputed key falls back to the now-dangling alias; the captured
      // key remains the storage target that was actually locked.
      expect(canonicalRepoLockKey(alias)).not.toBe(captured);
      expect(captured).toBe(path.join(canonicalTarget, '.gitnexus'));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('POST /api/embed completed-checkpoint identity', () => {
  let baseUrl = '';
  let shutdown: (() => Promise<void>) | undefined;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let onceSpy: ReturnType<typeof vi.spyOn>;
  let getJobSpy: ReturnType<typeof vi.spyOn>;
  let priorGitNexusHome: string | undefined;
  let isolatedGitNexusHomeRoot = '';

  beforeAll(async () => {
    priorGitNexusHome = process.env.GITNEXUS_HOME;
    isolatedGitNexusHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-api-owner-home-'));
    process.env.GITNEXUS_HOME = path.join(isolatedGitNexusHomeRoot, 'home');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const originalOnce = process.once.bind(process);
    onceSpy = vi.spyOn(process, 'once').mockImplementation(((event: string, listener: Function) => {
      if (event === 'SIGTERM') {
        shutdown = listener as () => Promise<void>;
        return process;
      }
      return originalOnce(event, listener);
    }) as typeof process.once);
    const originalGetJob = JobManager.prototype.getJob;
    getJobSpy = vi.spyOn(JobManager.prototype, 'getJob').mockImplementation(function (
      this: JobManager,
      id: string,
    ) {
      const job = originalGetJob.call(this, id);
      state.deleteHandlerStarted?.();
      return job;
    });

    const { createServer } = await import('../../src/server/api.js');
    const port = await allocatePort();
    await createServer(port, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${port}`;
  });

  beforeEach(() => {
    state.releaseAnalyzeLock?.();
    state.releaseAnalyzeLock = undefined;
    state.currentMeta = makeMeta(MISMATCHED_DIGEST);
    state.liveIntegrity = makeIntegrity(LIVE_DIGEST);
    state.graphNodes = [{ id: 'node-1' }];
    state.executeQuery.mockReset();
    state.executeQuery.mockImplementation(async () => state.graphNodes);
    state.openModes.length = 0;
    state.openOwnershipPaths.length = 0;
    state.openOwnershipRepoRoots.length = 0;
    state.ownershipGate = undefined;
    state.releaseOwnershipLease.mockReset();
    state.releaseOwnershipLease.mockResolvedValue(undefined);
    state.acquireLbugOwnership.mockClear();
    state.closeLbug.mockClear();
    state.withLbugReadOnlyNonRecovering.mockClear();
    state.withLbugDb.mockClear();
    state.getActiveEmbeddingIdentity.mockClear();
    state.inspectEmbeddingIntegrity.mockReset();
    state.inspectEmbeddingIntegrity.mockImplementation(async () => state.liveIntegrity);
    state.getStrictLbugStats.mockReset();
    state.getStrictLbugStats.mockResolvedValue({ nodes: 4, edges: 5 });
    state.runEmbeddingPipeline.mockReset();
    state.runEmbeddingPipeline.mockResolvedValue(undefined);
    state.registerRepo.mockReset();
    state.registerRepo.mockImplementation(
      async (
        _repoPath?: string,
        _meta?: RepoMeta,
        options?: {
          commitReceipt?: {
            value?: { previousOwner: RegistryEntry | null; committedOwner: RegistryEntry };
          };
        },
      ) => {
        if (options?.commitReceipt) {
          options.commitReceipt.value = { previousOwner: REPO, committedOwner: REPO };
        }
        return REPO.name;
      },
    );
    state.rollbackRegistryCommit.mockClear();
    state.unregisterRepo.mockReset();
    state.unregisterRepo.mockResolvedValue(undefined);
    state.saveMeta.mockClear();
    state.loadMeta.mockReset();
    state.loadMeta.mockImplementation(async () => state.currentMeta);
    state.listRegisteredRepos.mockReset();
    state.listRegisteredRepos.mockResolvedValue([REPO]);
    state.deleteHandlerStarted = undefined;
    state.afterSafeStorageValidation = undefined;
  });

  afterAll(async () => {
    onceSpy.mockRestore();
    getJobSpy.mockRestore();
    await shutdown?.();
    exitSpy.mockRestore();
    if (priorGitNexusHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = priorGitNexusHome;
    await fs.rm(isolatedGitNexusHomeRoot, { recursive: true, force: true });
  });

  it('releases the repository lock when embedding job admission throws', async () => {
    const createJobSpy = vi.spyOn(JobManager.prototype, 'createJob').mockImplementationOnce(() => {
      throw new Error('test admission failure');
    });
    const failedAdmission = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    expect(failedAdmission.status).toBe(500);
    createJobSpy.mockRestore();

    const retry = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    expect(retry.status).toBe(202);
    const { jobId } = (await retry.json()) as { jobId: string };
    await waitForTerminalJob(baseUrl, jobId);
  });

  it('admits writable embedding through the frozen cross-process owner', async () => {
    state.currentMeta = makeMeta(LIVE_DIGEST);
    let releaseOwnership!: () => void;
    state.ownershipGate = new Promise<void>((resolve) => {
      releaseOwnership = resolve;
    });

    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    await vi.waitFor(() => expect(state.openModes).toHaveLength(1));

    expect(state.openOwnershipPaths).toEqual([canonicalizePath(REPO.storagePath)]);
    expect(state.openOwnershipRepoRoots).toEqual([canonicalizePath(REPO.path)]);
    expect(state.loadMeta).toHaveBeenCalledOnce();
    expect(state.saveMeta).not.toHaveBeenCalled();
    expect(state.releaseOwnershipLease).not.toHaveBeenCalled();

    releaseOwnership();
    await expect(waitForTerminalJob(baseUrl, jobId)).resolves.toMatchObject({
      status: 'complete',
      progress: { phase: 'complete', percent: 100 },
    });
    expect(state.releaseOwnershipLease).toHaveBeenCalledOnce();
  });

  it('acquires cross-process ownership before legacy metadata and database preflight', async () => {
    state.currentMeta = makeMeta(LIVE_DIGEST, REPO.path, true);
    state.liveIntegrity = makeIntegrity(LIVE_DIGEST, 0);
    state.graphNodes = [];

    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    expect(response.status).toBe(202);
    const { jobId } = (await response.json()) as { jobId: string };
    await expect(waitForTerminalJob(baseUrl, jobId)).resolves.toMatchObject({ status: 'complete' });

    expect(state.acquireLbugOwnership).toHaveBeenCalledOnce();
    expect(state.withLbugReadOnlyNonRecovering).toHaveBeenCalledOnce();
    expect(state.acquireLbugOwnership.mock.invocationCallOrder[0]).toBeLessThan(
      state.withLbugReadOnlyNonRecovering.mock.invocationCallOrder[0],
    );
    expect(state.releaseOwnershipLease).toHaveBeenCalledOnce();
    expect(state.withLbugReadOnlyNonRecovering.mock.invocationCallOrder[0]).toBeLessThan(
      state.releaseOwnershipLease.mock.invocationCallOrder[0],
    );
  });

  it('reports ownership cleanup failure together with the embedding failure', async () => {
    state.loadMeta.mockRejectedValueOnce(new Error('preflight failed'));
    state.releaseOwnershipLease.mockRejectedValue(new Error('release retries exhausted'));

    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    expect(response.status).toBe(202);
    const { jobId } = (await response.json()) as { jobId: string };
    const job = await waitForTerminalJob(baseUrl, jobId);

    expect(job).toMatchObject({
      status: 'failed',
      progress: { phase: 'failed' },
    });
    expect(job.error).toMatch(/preflight failed/);
    expect(job.error).toMatch(/ownership lock release failed: release retries exhausted/i);
    expect(state.releaseOwnershipLease).toHaveBeenCalledOnce();
  });

  it('terminalizes an empty embedding error with the fallback message', async () => {
    state.loadMeta.mockRejectedValueOnce(new Error(''));

    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    expect(response.status).toBe(202);
    const { jobId } = (await response.json()) as { jobId: string };

    await expect(waitForTerminalJob(baseUrl, jobId)).resolves.toMatchObject({
      status: 'failed',
      error: 'Embedding generation failed',
    });
  });

  it('publishes cancellation and ownership cleanup failures together after release', async () => {
    state.currentMeta = makeMeta(LIVE_DIGEST);
    let pipelineStarted!: () => void;
    const pipelineRunning = new Promise<void>((resolve) => {
      pipelineStarted = resolve;
    });
    state.runEmbeddingPipeline.mockImplementation(async (...args: unknown[]) => {
      const reportProgress = args[2] as (progress: { phase: string; percent: number }) => void;
      const options = args[6] as { signal: AbortSignal };
      pipelineStarted();
      await new Promise<void>((_resolve, reject) => {
        const rejectWithWrappedAbort = () => {
          reportProgress({ phase: 'error', percent: 0 });
          const wrapped = new Error('Embedding request cancelled (redacted endpoint)', {
            cause: new DOMException('pipeline cancelled', 'AbortError'),
          });
          wrapped.name = 'HttpEmbeddingError';
          reject(wrapped);
        };
        if (options.signal.aborted) {
          rejectWithWrappedAbort();
          return;
        }
        options.signal.addEventListener('abort', rejectWithWrappedAbort, { once: true });
      });
    });
    let cleanupStarted!: () => void;
    const cleanupRunning = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    let failCleanup!: () => void;
    const cleanupRelease = new Promise<void>((_resolve, reject) => {
      failCleanup = () => reject(new Error('release retries exhausted'));
    });
    state.releaseOwnershipLease.mockImplementation(async () => {
      cleanupStarted();
      return cleanupRelease;
    });

    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    expect(response.status).toBe(202);
    const { jobId } = (await response.json()) as { jobId: string };
    await pipelineRunning;

    const progressResponse = await fetch(`${baseUrl}/api/embed/${jobId}/progress`);
    expect(progressResponse.status).toBe(200);
    let progressSettled = false;
    const progressText = progressResponse.text().then((text) => {
      progressSettled = true;
      return text;
    });

    const cancelled = await fetch(`${baseUrl}/api/embed/${jobId}`, { method: 'DELETE' });
    expect(cancelled.status).toBe(200);
    await cleanupRunning;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(progressSettled).toBe(false);

    failCleanup();
    const job = await waitForTerminalJob(baseUrl, jobId);
    const events = await progressText;

    expect(job).toMatchObject({ status: 'failed' });
    expect(job.error).toMatch(/cancelled by user/i);
    expect(job.error).toMatch(/ownership lock release failed: release retries exhausted/i);
    expect(events).toMatch(/event: failed/);
    expect(events).toMatch(/cancelled by user/i);
    expect(events).toMatch(/ownership lock release failed: release retries exhausted/i);
    expect(state.releaseOwnershipLease).toHaveBeenCalledOnce();
  });

  it('keeps cancellation failed when accepted during successful ownership release', async () => {
    state.currentMeta = makeMeta(LIVE_DIGEST);
    let releaseStarted!: () => void;
    const releaseRunning = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    let finishRelease!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    state.releaseOwnershipLease.mockImplementationOnce(async () => {
      releaseStarted();
      await releaseGate;
    });

    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    expect(response.status).toBe(202);
    const { jobId } = (await response.json()) as { jobId: string };
    await releaseRunning;

    const deleteHandlerStarted = armDeleteHandlerSignal();
    const cancellationResponse = fetch(`${baseUrl}/api/embed/${jobId}`, { method: 'DELETE' });
    await deleteHandlerStarted;
    const cancelled = await cancellationResponse;
    expect(cancelled.status).toBe(200);
    finishRelease();

    await expect(waitForTerminalJob(baseUrl, jobId)).resolves.toMatchObject({
      status: 'failed',
      error: 'Cancelled by user',
    });
    expect(state.releaseOwnershipLease).toHaveBeenCalledOnce();
  });

  it('rejects an equal-count different-digest completed window before the pipeline', async () => {
    const checkpointBefore = JSON.stringify(state.currentMeta.embeddingCheckpoint);
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    expect(response.status).toBe(202);
    const { jobId } = (await response.json()) as { jobId: string };
    const job = await waitForTerminalJob(baseUrl, jobId);

    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/durable identity no longer matches/i);
    expect(state.runEmbeddingPipeline).not.toHaveBeenCalled();
    expect(state.saveMeta).not.toHaveBeenCalled();
    expect(JSON.stringify(state.currentMeta.embeddingCheckpoint)).toBe(checkpointBefore);
  });

  it.each([
    { field: 'provider', mismatch: { provider: 'other-provider' } },
    { field: 'model', mismatch: { model: 'other-model' } },
    { field: 'dimensions', mismatch: { dimensions: 768 } },
  ])('rejects a $field mismatch before opening writable LadybugDB', async ({ mismatch }) => {
    state.currentMeta = makeMeta(LIVE_DIGEST);
    state.currentMeta.embeddingCheckpoint = {
      ...state.currentMeta.embeddingCheckpoint!,
      ...mismatch,
    };
    const checkpointBefore = JSON.stringify(state.currentMeta.embeddingCheckpoint);
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    expect(response.status).toBe(202);
    const { jobId } = (await response.json()) as { jobId: string };
    const job = await waitForTerminalJob(baseUrl, jobId);

    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/Cannot resume embedding checkpoint/);
    expect(state.getActiveEmbeddingIdentity).toHaveBeenCalledOnce();
    expect(state.withLbugDb).not.toHaveBeenCalled();
    expect(state.inspectEmbeddingIntegrity).not.toHaveBeenCalled();
    expect(state.executeQuery).not.toHaveBeenCalled();
    expect(state.runEmbeddingPipeline).not.toHaveBeenCalled();
    expect(state.saveMeta).not.toHaveBeenCalled();
    expect(JSON.stringify(state.currentMeta.embeddingCheckpoint)).toBe(checkpointBefore);
  });

  it('routes an ordinary checkpoint through writable recovery and finalizes metadata', async () => {
    state.currentMeta = makeMeta(LIVE_DIGEST);
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    expect(response.status).toBe(202);
    const { jobId } = (await response.json()) as { jobId: string };
    const job = await waitForTerminalJob(baseUrl, jobId);

    expect(job.status).toBe('complete');
    expect(state.openModes).toEqual([undefined]);
    expect(state.withLbugReadOnlyNonRecovering).not.toHaveBeenCalled();
    expect(state.runEmbeddingPipeline).toHaveBeenCalledOnce();
    expect(state.currentMeta.stats?.embeddings).toBe(3);
    expect(state.currentMeta.embeddingCheckpoint).toBeUndefined();
  });

  it('fails ordinary completion when the owner retargets during terminal metadata save', async () => {
    const fixture = await prepareSymlinkRace('gitnexus-issue269-ordinary-terminal-');
    state.currentMeta = makeMeta(LIVE_DIGEST, fixture.alias);
    state.liveIntegrity = makeIntegrity(LIVE_DIGEST, 3);
    state.graphNodes = [{ id: 'node-1' }];
    state.listRegisteredRepos.mockResolvedValue([fixture.raceRepo]);
    state.saveMeta.mockImplementationOnce(async (_storagePath, next) => {
      state.currentMeta = next;
      await fixture.retarget();
    });

    try {
      const job = await runEmbedJob(baseUrl, fixture.raceRepo.name);

      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/path\/storage identity is non-absolute or mismatched/i);
      expect(state.runEmbeddingPipeline).toHaveBeenCalledOnce();
      expect(state.saveMeta).toHaveBeenCalledOnce();
      expect(state.currentMeta.embeddingCheckpoint).toBeUndefined();
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects a nonlegacy provider mismatch before writable Ladybug', async () => {
    state.currentMeta.embeddingCheckpoint = {
      ...state.currentMeta.embeddingCheckpoint!,
      model: 'other-model',
    };
    const before = JSON.stringify(state.currentMeta.embeddingCheckpoint);
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    const job = await waitForTerminalJob(baseUrl, jobId);

    expect(job.error).toMatch(/but this run resolves/);
    expect(job.error).toMatch(/do not retry POST \/api\/embed/i);
    expect(job.error).toMatch(/gitnexus analyze --force --drop-embeddings --embeddings 0/);
    expect(job.error).not.toMatch(/POST \/api\/analyze/);
    expect(state.openModes).toEqual([]);
    expect(state.withLbugReadOnlyNonRecovering).not.toHaveBeenCalled();
    expect(state.withLbugDb).not.toHaveBeenCalled();
    expect(state.getActiveEmbeddingIdentity).toHaveBeenCalledOnce();
    expect(JSON.stringify(state.currentMeta.embeddingCheckpoint)).toBe(before);
  });

  it('refuses metadata drift before provider-capable work', async () => {
    const initial = { ...makeMeta(LIVE_DIGEST), embeddingCheckpoint: undefined };
    const changed = makeMeta(LIVE_DIGEST);
    changed.embeddingCheckpoint = {
      ...changed.embeddingCheckpoint!,
      nodesProcessed: 0,
      totalNodes: 0,
      provider: undefined,
      physicalRows: undefined,
      validRows: undefined,
      recoverableIdentitySha256: undefined,
    };
    state.loadMeta.mockResolvedValueOnce(initial).mockResolvedValue(changed);
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    const job = await waitForTerminalJob(baseUrl, jobId);

    expect(job.error).toMatch(/metadata changed during preflight/i);
    expect(job.error).toMatch(/retry POST \/api\/embed after the current repository operation/i);
    expect(job.error).toMatch(/ask the repository owner/i);
    expect(job.error).not.toMatch(/do not retry|--drop-embeddings|analyze --force/i);
    expect(state.openModes).toEqual([undefined]);
    expect(state.getActiveEmbeddingIdentity).not.toHaveBeenCalled();
    expect(state.runEmbeddingPipeline).not.toHaveBeenCalled();
    expect(state.saveMeta).not.toHaveBeenCalled();
  });

  it('refuses tentative legacy classification drift before writable Ladybug', async () => {
    const initial = makeMeta(LIVE_DIGEST);
    initial.embeddingCheckpoint = {
      ...initial.embeddingCheckpoint!,
      nodesProcessed: 0,
      totalNodes: 0,
      provider: undefined,
      physicalRows: undefined,
      validRows: undefined,
      recoverableIdentitySha256: undefined,
    };
    const changed = { ...initial, embeddingCheckpoint: undefined };
    state.loadMeta.mockResolvedValueOnce(initial).mockResolvedValue(changed);
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    const job = await waitForTerminalJob(baseUrl, jobId);

    expect(job.error).toMatch(/metadata changed during preflight/i);
    expect(job.error).toMatch(/retry POST \/api\/embed after the current repository operation/i);
    expect(job.error).toMatch(/ask the repository owner/i);
    expect(job.error).not.toMatch(/do not retry|--drop-embeddings|analyze --force/i);
    expect(state.openModes).toEqual([true]);
    expect(state.withLbugDb).not.toHaveBeenCalled();
    expect(state.getActiveEmbeddingIdentity).not.toHaveBeenCalled();
    expect(state.runEmbeddingPipeline).not.toHaveBeenCalled();
  });

  it('refuses legacy zero-row drift after writable open', async () => {
    state.currentMeta.embeddingCheckpoint = {
      ...state.currentMeta.embeddingCheckpoint!,
      nodesProcessed: 0,
      totalNodes: 0,
      provider: undefined,
      physicalRows: undefined,
      validRows: undefined,
      recoverableIdentitySha256: undefined,
    };
    state.inspectEmbeddingIntegrity
      .mockResolvedValueOnce(makeIntegrity(LIVE_DIGEST, 0))
      .mockResolvedValueOnce(makeIntegrity(LIVE_DIGEST, 1));
    state.executeQuery.mockResolvedValue([{ id: 'Function:current' }]);
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    const job = await waitForTerminalJob(baseUrl, jobId);

    expect(job.error).toMatch(/unknown-provider while the table contains rows/i);
    expect(state.openModes).toEqual([true, undefined]);
    expect(state.getActiveEmbeddingIdentity).not.toHaveBeenCalled();
    expect(state.runEmbeddingPipeline).not.toHaveBeenCalled();
    expect(state.saveMeta).not.toHaveBeenCalled();
  });

  it('clears a legacy zero-node checkpoint with registry-enriched remote', async () => {
    const enrichedRepo = { ...REPO, remoteUrl: 'https://example.invalid/enriched.git' };
    state.listRegisteredRepos.mockResolvedValue([enrichedRepo]);
    state.currentMeta = makeMeta(LIVE_DIGEST);
    state.currentMeta.stats = { nodes: 17, edges: 19, embeddings: 3 };
    state.currentMeta.embeddingCheckpoint = {
      ...state.currentMeta.embeddingCheckpoint!,
      nodesProcessed: 0,
      totalNodes: 0,
      provider: undefined,
      physicalRows: undefined,
      validRows: undefined,
      recoverableIdentitySha256: undefined,
    };
    state.liveIntegrity = { ...state.liveIntegrity, physicalRows: 0, validRows: 0 };
    state.executeQuery.mockImplementation(async (query: string) =>
      query.includes('MATCH (n:`File`)') && !query.includes("trim(n.content) <> ''")
        ? [{ id: 'File:whitespace', content: '   ' }]
        : [],
    );
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    expect((await waitForTerminalJob(baseUrl, jobId)).status).toBe('complete');
    expect(state.openModes).toEqual([true, undefined]);
    expect(state.closeLbug).toHaveBeenCalledOnce();
    expect(state.runEmbeddingPipeline).not.toHaveBeenCalled();
    expect(state.getStrictLbugStats).toHaveBeenCalledOnce();
    expect(state.getStrictLbugStats.mock.invocationCallOrder[0]).toBeLessThan(
      state.listRegisteredRepos.mock.invocationCallOrder[1],
    );
    expect(state.listRegisteredRepos).toHaveBeenCalledTimes(3);
    expect(state.listRegisteredRepos.mock.invocationCallOrder[1]).toBeLessThan(
      state.registerRepo.mock.invocationCallOrder[0],
    );
    expect(state.registerRepo.mock.invocationCallOrder[0]).toBeLessThan(
      state.saveMeta.mock.invocationCallOrder[0],
    );
    expect(state.saveMeta.mock.invocationCallOrder[0]).toBeLessThan(
      state.listRegisteredRepos.mock.invocationCallOrder[2],
    );
    expect(state.registerRepo).toHaveBeenCalledWith(
      REPO.path,
      expect.objectContaining({
        stats: { nodes: 4, edges: 5, embeddings: 0 },
        embeddingCheckpoint: undefined,
      }),
      {
        name: REPO.name,
        allowDuplicateName: true,
        commitReceipt: expect.objectContaining({ value: expect.anything() }),
        expectedOwner: expect.objectContaining({
          ...enrichedRepo,
          canonicalPath: enrichedRepo.path,
          canonicalStoragePath: enrichedRepo.storagePath,
        }),
      },
    );
    expect(state.saveMeta).toHaveBeenCalledWith(REPO.storagePath, expect.anything());
    expect(state.currentMeta.stats).toEqual({ nodes: 4, edges: 5, embeddings: 0 });
    expect(state.currentMeta.remoteUrl).toBeUndefined();
    expect(state.currentMeta.embeddingCheckpoint).toBeUndefined();
  });

  it.each([
    ['lastCommit', { lastCommit: 'newer-head' }],
    ['indexedAt', { indexedAt: '2026-08-25T00:00:00.000Z' }],
  ])('retains a zero-node checkpoint when only registry $field changes', async (_field, drift) => {
    state.currentMeta = makeMeta(LIVE_DIGEST, REPO.path, true);
    state.liveIntegrity = makeIntegrity(LIVE_DIGEST, 0);
    state.graphNodes = [];
    const checkpointBefore = JSON.stringify(state.currentMeta.embeddingCheckpoint);
    state.listRegisteredRepos
      .mockResolvedValueOnce([REPO])
      .mockResolvedValue([{ ...REPO, ...drift }]);

    const job = await runEmbedJob(baseUrl, REPO.name);

    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/registry owner generation changed/i);
    expect(job.error).toMatch(/retry after the current repository operation finishes/i);
    expect(state.registerRepo).not.toHaveBeenCalled();
    expect(state.saveMeta).not.toHaveBeenCalled();
    expect(JSON.stringify(state.currentMeta.embeddingCheckpoint)).toBe(checkpointBefore);
  });

  it('retains the checkpoint when the owner symlink retargets after registry commit', async () => {
    const fixture = await prepareSymlinkRace('gitnexus-issue269-');
    state.listRegisteredRepos.mockResolvedValue([fixture.raceRepo]);
    state.registerRepo.mockImplementation(async (_repoPath, _meta, options) => {
      if (options?.commitReceipt) {
        options.commitReceipt.value = {
          previousOwner: fixture.raceRepo,
          committedOwner: fixture.raceRepo,
        };
      }
      await fixture.retarget();
      return fixture.raceRepo.name;
    });

    await runSymlinkRace(
      baseUrl,
      fixture,
      /path\/storage identity is non-absolute or mismatched/i,
      () => {
        expect(state.registerRepo).toHaveBeenCalledOnce();
        expect(state.rollbackRegistryCommit).toHaveBeenCalledOnce();
      },
    );
  });

  it('restores registry and metadata preimages when the owner retargets during a successful save', async () => {
    const fixture = await prepareSymlinkRace('gitnexus-issue269-post-save-');
    state.listRegisteredRepos.mockResolvedValue([fixture.raceRepo]);
    const checkpointBefore = JSON.stringify(state.currentMeta.embeddingCheckpoint);
    state.registerRepo.mockImplementation(async (_repoPath, _meta, options) => {
      if (options?.commitReceipt) {
        options.commitReceipt.value = {
          previousOwner: fixture.raceRepo,
          committedOwner: fixture.raceRepo,
        };
      }
      return fixture.raceRepo.name;
    });
    state.saveMeta.mockImplementationOnce(async (_storagePath, next) => {
      state.currentMeta = next;
      await fixture.retarget();
    });

    try {
      const job = await runEmbedJob(baseUrl, fixture.raceRepo.name);
      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/path\/storage identity is non-absolute or mismatched/i);
      expect(state.registerRepo).toHaveBeenCalledOnce();
      expect(state.rollbackRegistryCommit).toHaveBeenCalledOnce();
      expect(state.saveMeta).toHaveBeenCalledTimes(2);
      expect(state.saveMeta).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining(path.join('canonical-a', '.gitnexus')),
        expect.objectContaining({ embeddingCheckpoint: expect.anything() }),
      );
      expect(JSON.stringify(state.currentMeta.embeddingCheckpoint)).toBe(checkpointBefore);
      expect(state.currentMeta.repoPath).toBe(fixture.alias);
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('uses one canonical lock to exclude embed and delete during symlinked analyze', async () => {
    const fixture = await prepareSymlinkRace('gitnexus-issue269-shared-lock-');
    state.listRegisteredRepos.mockResolvedValue([fixture.raceRepo]);
    try {
      const analyze = await fetch(`${baseUrl}/api/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: fixture.alias }),
      });
      expect(analyze.status).toBe(202);
      await vi.waitFor(() => expect(state.releaseAnalyzeLock).toBeTypeOf('function'));

      const embed = await fetch(`${baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo: fixture.raceRepo.name }),
      });
      expect(embed.status).toBe(409);

      const remove = await fetch(
        `${baseUrl}/api/repo?repo=${encodeURIComponent(fixture.raceRepo.name)}`,
        { method: 'DELETE' },
      );
      expect(remove.status).toBe(409);
    } finally {
      state.releaseAnalyzeLock?.();
      state.releaseAnalyzeLock = undefined;
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('refuses delete while the production analyze ownership lock is held and releases cleanly', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-delete-analyze-owner-'));
    const repoRoot = path.join(root, 'repo');
    const storagePath = path.join(repoRoot, '.gitnexus');
    const sentinel = path.join(storagePath, 'sentinel.txt');
    await fs.mkdir(storagePath, { recursive: true });
    await fs.writeFile(sentinel, 'preserve');
    const entry = { ...REPO, path: repoRoot, storagePath };
    state.listRegisteredRepos.mockResolvedValue([entry]);
    expect(canonicalRepoLockKey(repoRoot)).toBe(canonicalizePath(storagePath));

    try {
      await withAnalyzeOwnershipLock(
        canonicalizePath(storagePath),
        async () => {
          const blocked = await fetch(
            `${baseUrl}/api/repo?repo=${encodeURIComponent(entry.name)}`,
            { method: 'DELETE' },
          );
          const body = (await blocked.json()) as { error?: string };

          expect(blocked.status).toBe(409);
          expect(body.error).toMatch(/another analyze is active/i);
          await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('preserve');
          expect(state.unregisterRepo).not.toHaveBeenCalled();
        },
        { repoRoot },
      );

      const removed = await fetch(`${baseUrl}/api/repo?repo=${encodeURIComponent(entry.name)}`, {
        method: 'DELETE',
      });
      expect(removed.status).toBe(200);
      expect(state.unregisterRepo).toHaveBeenCalledOnce();
      await expect(fs.lstat(storagePath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reports ownership-release failure before publishing delete success', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-delete-release-failure-'));
    const repoRoot = path.join(root, 'repo');
    const storagePath = path.join(repoRoot, '.gitnexus');
    await fs.mkdir(storagePath, { recursive: true });
    const entry = { ...REPO, path: repoRoot, storagePath };
    state.listRegisteredRepos.mockResolvedValue([entry]);
    const originalRm = fs.rm.bind(fs);
    const rmSpy = vi.spyOn(fs, 'rm');
    let releaseAttempts = 0;

    rmSpy.mockImplementation(async (target, options) => {
      const targetPath = String(target);
      const targetName = path.basename(targetPath);
      if (
        state.unregisterRepo.mock.calls.length > 0 &&
        targetName.startsWith('analyze-') &&
        targetName !== 'analyze-staged.lock' &&
        targetPath.endsWith('.lock')
      ) {
        releaseAttempts++;
        throw Object.assign(new Error('delete ownership release failed'), { code: 'EPERM' });
      }
      return originalRm(target, options);
    });

    try {
      const response = await fetch(`${baseUrl}/api/repo?repo=${encodeURIComponent(entry.name)}`, {
        method: 'DELETE',
      });
      const body = (await response.json()) as { error?: string; deleted?: string };

      expect(response.status).toBe(500);
      expect(body.deleted).toBeUndefined();
      expect(body.error).toMatch(/delete ownership release failed/i);
      expect(releaseAttempts).toBe(3);
    } finally {
      rmSpy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
      const gitnexusHome = process.env.GITNEXUS_HOME;
      if (gitnexusHome) {
        await fs.rm(path.join(gitnexusHome, 'locks'), { recursive: true, force: true });
      }
    }
  });

  it('refuses reverse-order analyze after delete detaches symlinked storage', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-delete-first-analyze-'));
    const repoRoot = path.join(root, 'repo');
    const externalStorage = path.join(root, 'external-storage');
    const sentinel = path.join(externalStorage, 'sentinel.txt');
    await fs.mkdir(repoRoot);
    await fs.mkdir(externalStorage);
    await fs.writeFile(sentinel, 'preserve');
    await fs.symlink(externalStorage, path.join(repoRoot, '.gitnexus'), 'dir');
    const entry = {
      ...REPO,
      path: repoRoot,
      storagePath: path.join(repoRoot, '.gitnexus'),
    };
    state.listRegisteredRepos.mockResolvedValue([entry]);
    let finishUnregister!: () => void;
    const unregisterGate = new Promise<void>((resolve) => {
      finishUnregister = resolve;
    });
    state.unregisterRepo.mockImplementationOnce(async () => unregisterGate);

    try {
      const removeResponse = fetch(`${baseUrl}/api/repo?repo=${encodeURIComponent(entry.name)}`, {
        method: 'DELETE',
      });
      await vi.waitFor(() => expect(state.unregisterRepo).toHaveBeenCalledOnce());
      await expect(fs.lstat(entry.storagePath)).rejects.toMatchObject({ code: 'ENOENT' });

      await expect(
        withAnalyzeOwnershipLock(canonicalizePath(entry.storagePath), async () => undefined, {
          repoRoot,
          createStoragePath: false,
        }),
      ).rejects.toThrow(/another analyze is active/i);
      await expect(fs.lstat(entry.storagePath)).rejects.toMatchObject({ code: 'ENOENT' });

      const analyze = await fetch(`${baseUrl}/api/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: repoRoot }),
      });
      expect(analyze.status).toBe(202);
      const { jobId } = (await analyze.json()) as { jobId: string };
      const job = (await (await fetch(`${baseUrl}/api/analyze/${jobId}`)).json()) as {
        status: string;
        error?: string;
      };
      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/another job is already active/i);
      await expect(fs.lstat(entry.storagePath)).rejects.toMatchObject({ code: 'ENOENT' });

      finishUnregister();
      expect((await removeResponse).status).toBe(200);
      await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('preserve');
    } finally {
      finishUnregister?.();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('deletes an absent registered index without materializing storage', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-delete-absent-storage-'));
    const repoRoot = path.join(root, 'repo');
    const storagePath = path.join(repoRoot, '.gitnexus');
    await fs.mkdir(repoRoot, { recursive: true });
    const entry = { ...REPO, path: repoRoot, storagePath };
    state.listRegisteredRepos.mockResolvedValue([entry]);

    try {
      const response = await fetch(`${baseUrl}/api/repo?repo=${encodeURIComponent(entry.name)}`, {
        method: 'DELETE',
      });

      const responseBody = (await response.clone().json()) as { error?: string };
      expect(response.status, responseBody.error).toBe(200);
      await expect(response.json()).resolves.toEqual({ deleted: entry.name });
      expect(state.unregisterRepo).toHaveBeenCalledOnce();
      await expect(fs.lstat(storagePath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('deletes only the lexical storage link while retaining its external target', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-issue269-delete-link-'));
    const repoRoot = path.join(root, 'repo');
    const externalStorage = path.join(root, 'external-storage');
    const sentinel = path.join(externalStorage, 'sentinel.txt');
    await fs.mkdir(repoRoot);
    await fs.mkdir(externalStorage);
    await fs.writeFile(sentinel, 'preserve');
    await fs.symlink(externalStorage, path.join(repoRoot, '.gitnexus'), 'dir');
    const entry = {
      ...REPO,
      path: repoRoot,
      storagePath: path.join(repoRoot, '.gitnexus'),
    };
    state.listRegisteredRepos.mockResolvedValue([entry]);

    try {
      const response = await fetch(`${baseUrl}/api/repo?repo=${encodeURIComponent(entry.name)}`, {
        method: 'DELETE',
      });
      expect(response.status).toBe(200);
      await expect(fs.lstat(entry.storagePath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('preserve');
      expect(state.unregisterRepo).toHaveBeenCalledWith(repoRoot, {
        expectedOwner: expect.objectContaining({
          ...entry,
          canonicalPath: canonicalizePath(repoRoot),
          canonicalStoragePath: canonicalizePath(externalStorage),
        }),
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('refuses delete when the repository symlink retargets after owner freeze', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-delete-root-retarget-'));
    const targetA = path.join(root, 'repo-a');
    const targetB = path.join(root, 'repo-b');
    const alias = path.join(root, 'repo-alias');
    const sentinelA = path.join(targetA, '.gitnexus', 'sentinel-a.txt');
    const sentinelB = path.join(targetB, '.gitnexus', 'sentinel-b.txt');
    await Promise.all([
      fs.mkdir(path.join(targetA, '.gitnexus'), { recursive: true }),
      fs.mkdir(path.join(targetB, '.gitnexus'), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(sentinelA, 'preserve a'),
      fs.writeFile(sentinelB, 'preserve b'),
    ]);
    await fs.symlink(targetA, alias, 'dir');
    const entry = { ...REPO, path: alias, storagePath: path.join(alias, '.gitnexus') };
    state.listRegisteredRepos.mockResolvedValue([entry]);
    state.afterSafeStorageValidation = () => {
      state.afterSafeStorageValidation = undefined;
      fsSync.unlinkSync(alias);
      fsSync.symlinkSync(targetB, alias, 'dir');
    };

    try {
      const response = await fetch(`${baseUrl}/api/repo?repo=${encodeURIComponent(entry.name)}`, {
        method: 'DELETE',
      });
      const body = (await response.json()) as { error?: string };

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/repository owner changed before deletion/i);
      await expect(fs.readFile(sentinelA, 'utf8')).resolves.toBe('preserve a');
      await expect(fs.readFile(sentinelB, 'utf8')).resolves.toBe('preserve b');
      expect(state.unregisterRepo).not.toHaveBeenCalled();
    } finally {
      state.afterSafeStorageValidation = undefined;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('returns an actionable failure when detached storage cleanup is preserved', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-delete-cleanup-failure-'));
    const repoRoot = path.join(root, 'repo');
    const storagePath = path.join(repoRoot, '.gitnexus');
    await fs.mkdir(storagePath, { recursive: true });
    await fs.writeFile(path.join(storagePath, 'sentinel.txt'), 'preserve');
    const entry = { ...REPO, path: repoRoot, storagePath };
    state.listRegisteredRepos.mockResolvedValue([entry]);
    const realRm = fs.rm.bind(fs);
    const rmSpy = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (String(target).includes('.gitnexus.delete-')) {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }
      return realRm(target, options);
    });

    try {
      const response = await fetch(`${baseUrl}/api/repo?repo=${encodeURIComponent(entry.name)}`, {
        method: 'DELETE',
      });
      const body = (await response.json()) as { error?: string };

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/could not remove detached storage/i);
      expect(body.error).toMatch(/preserved .*\.gitnexus\.delete-/i);
      expect(state.unregisterRepo).toHaveBeenCalledOnce();
      const preservedPath = body.error?.match(/preserved (.+?)\. Resolve/)?.[1];
      expect(preservedPath).toBeTruthy();
      await expect(fs.readFile(path.join(preservedPath!, 'sentinel.txt'), 'utf8')).resolves.toBe(
        'preserve',
      );
    } finally {
      rmSpy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('refuses delete when the captured storage link is replaced by a directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-issue269-delete-replace-'));
    const repoRoot = path.join(root, 'repo');
    const externalStorage = path.join(root, 'external-storage');
    const externalSentinel = path.join(externalStorage, 'preserved.txt');
    const replacementSentinel = path.join(repoRoot, '.gitnexus', 'replacement.txt');
    await fs.mkdir(repoRoot);
    await fs.mkdir(externalStorage);
    await fs.writeFile(externalSentinel, 'preserve external');
    await fs.symlink(externalStorage, path.join(repoRoot, '.gitnexus'), 'dir');
    const entry = {
      ...REPO,
      path: repoRoot,
      storagePath: path.join(repoRoot, '.gitnexus'),
    };
    state.listRegisteredRepos.mockResolvedValue([entry]);
    state.closeLbug.mockImplementationOnce(async () => {
      await fs.unlink(entry.storagePath);
      await fs.mkdir(entry.storagePath);
      await fs.writeFile(replacementSentinel, 'preserve replacement');
    });

    try {
      const response = await fetch(`${baseUrl}/api/repo?repo=${encodeURIComponent(entry.name)}`, {
        method: 'DELETE',
      });
      const body = (await response.json()) as { error?: string };

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/storage identity changed before deletion/i);
      await expect(fs.readFile(externalSentinel, 'utf8')).resolves.toBe('preserve external');
      await expect(fs.readFile(replacementSentinel, 'utf8')).resolves.toBe('preserve replacement');
      expect(state.unregisterRepo).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a symlink retarget during zero-checkpoint preflight before registerRepo', async () => {
    const fixture = await prepareSymlinkRace('gitnexus-issue269-preflight-');
    let registryReads = 0;
    state.listRegisteredRepos.mockImplementation(async () => {
      registryReads += 1;
      if (registryReads === 2) {
        await fixture.retarget();
      }
      return [fixture.raceRepo];
    });

    await runSymlinkRace(
      baseUrl,
      fixture,
      /path\/storage identity is non-absolute or mismatched/i,
      () => {
        expect(state.registerRepo).not.toHaveBeenCalled();
      },
    );
  });

  it('rejects a symlink retarget after DB work before the terminal owner helper', async () => {
    const fixture = await prepareSymlinkRace('gitnexus-issue269-pre-helper-');
    state.listRegisteredRepos.mockResolvedValue([fixture.raceRepo]);
    state.getStrictLbugStats.mockImplementationOnce(async () => {
      await fixture.retarget();
      return { nodes: 4, edges: 5 };
    });

    await runSymlinkRace(
      baseUrl,
      fixture,
      /path\/storage identity is non-absolute or mismatched/i,
      () => {
        expect(state.getStrictLbugStats).toHaveBeenCalledOnce();
        expect(state.registerRepo).not.toHaveBeenCalled();
      },
    );
  });

  it.each<{ label: string; entries: RegistryEntry[]; error: RegExp }>([
    { label: 'missing owner', entries: [], error: /canonical registry entry is missing/ },
    {
      label: 'duplicate owners',
      entries: [REPO, { ...REPO }],
      error: /canonical registry has duplicate entries/,
    },
    {
      label: 'nonabsolute path',
      entries: [{ ...REPO, path: 'relative/checkpoint-fixture' }],
      error: /path\/storage identity is non-absolute or mismatched/,
    },
    {
      label: 'nonabsolute storage',
      entries: [{ ...REPO, storagePath: 'relative/.gitnexus' }],
      error: /path\/storage identity is non-absolute or mismatched/,
    },
    {
      label: 'mismatched path',
      entries: [{ ...REPO, path: '/virtual/other-checkpoint-fixture' }],
      error: /path\/storage identity is non-absolute or mismatched/,
    },
    {
      label: 'mismatched storage',
      entries: [{ ...REPO, storagePath: '/virtual/other-checkpoint-fixture/.gitnexus' }],
      error: /path\/storage identity is non-absolute or mismatched/,
    },
    {
      label: 'alias drift',
      entries: [{ ...REPO, name: 'changed-alias' }],
      error: /registry owner identity changed/,
    },
    {
      label: 'remote drift',
      entries: [{ ...REPO, remoteUrl: 'https://example.invalid/changed.git' }],
      error: /registry owner identity changed/,
    },
    {
      label: 'branch drift',
      entries: [{ ...REPO, branch: 'changed-branch' }],
      error: /registry owner identity changed/,
    },
  ])('rejects $label before either zero-checkpoint write', async ({ entries, error }) => {
    state.currentMeta = makeMeta(LIVE_DIGEST);
    state.currentMeta.embeddingCheckpoint = {
      ...state.currentMeta.embeddingCheckpoint!,
      nodesProcessed: 0,
      totalNodes: 0,
      provider: undefined,
      physicalRows: undefined,
      validRows: undefined,
      recoverableIdentitySha256: undefined,
    };
    state.liveIntegrity = makeIntegrity(LIVE_DIGEST, 0);
    state.executeQuery.mockResolvedValue([]);
    state.listRegisteredRepos.mockResolvedValueOnce([REPO]).mockResolvedValueOnce(entries);
    const checkpointBefore = JSON.stringify(state.currentMeta.embeddingCheckpoint);

    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    const job = await waitForTerminalJob(baseUrl, jobId);

    expect(job.status).toBe('failed');
    expect(job.error).toMatch(error);
    expect(state.listRegisteredRepos).toHaveBeenCalledTimes(2);
    expect(state.registerRepo).not.toHaveBeenCalled();
    expect(state.saveMeta).not.toHaveBeenCalled();
    expect(JSON.stringify(state.currentMeta.embeddingCheckpoint)).toBe(checkpointBefore);
  });

  it('fails before primary metadata when zero-checkpoint registry persistence rejects', async () => {
    state.currentMeta = makeMeta(LIVE_DIGEST);
    state.currentMeta.embeddingCheckpoint = {
      ...state.currentMeta.embeddingCheckpoint!,
      nodesProcessed: 0,
      totalNodes: 0,
      provider: undefined,
      physicalRows: undefined,
      validRows: undefined,
      recoverableIdentitySha256: undefined,
    };
    state.liveIntegrity = makeIntegrity(LIVE_DIGEST, 0);
    state.executeQuery.mockResolvedValue([]);
    state.registerRepo.mockRejectedValueOnce(
      new Error('GitNexus: expected registry owner changed during locked commit'),
    );
    const checkpointBefore = JSON.stringify(state.currentMeta.embeddingCheckpoint);

    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    const job = await waitForTerminalJob(baseUrl, jobId);

    expect(job).toMatchObject({
      status: 'failed',
      error: 'GitNexus: expected registry owner changed during locked commit',
    });
    expect(state.registerRepo).toHaveBeenCalledOnce();
    expect(state.saveMeta).not.toHaveBeenCalled();
    expect(JSON.stringify(state.currentMeta.embeddingCheckpoint)).toBe(checkpointBefore);
  });

  it('fails after registry success when primary save rejects and retry converges', async () => {
    state.currentMeta = makeMeta(LIVE_DIGEST);
    state.currentMeta.embeddingCheckpoint = {
      ...state.currentMeta.embeddingCheckpoint!,
      nodesProcessed: 0,
      totalNodes: 0,
      provider: undefined,
      physicalRows: undefined,
      validRows: undefined,
      recoverableIdentitySha256: undefined,
    };
    state.liveIntegrity = makeIntegrity(LIVE_DIGEST, 0);
    state.executeQuery.mockResolvedValue([]);
    state.saveMeta.mockRejectedValueOnce(new Error('primary persistence failed'));
    const checkpointBefore = JSON.stringify(state.currentMeta.embeddingCheckpoint);

    const firstResponse = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId: firstJobId } = (await firstResponse.json()) as { jobId: string };
    const failedJob = await waitForTerminalJob(baseUrl, firstJobId);

    expect(failedJob).toMatchObject({ status: 'failed', error: 'primary persistence failed' });
    expect(state.registerRepo).toHaveBeenCalledOnce();
    expect(state.saveMeta).toHaveBeenCalledOnce();
    expect(JSON.stringify(state.currentMeta.embeddingCheckpoint)).toBe(checkpointBefore);

    const retryResponse = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId: retryJobId } = (await retryResponse.json()) as { jobId: string };

    expect((await waitForTerminalJob(baseUrl, retryJobId)).status).toBe('complete');
    expect(state.registerRepo).toHaveBeenCalledTimes(2);
    expect(state.saveMeta).toHaveBeenCalledTimes(2);
    expect(state.currentMeta.stats).toEqual({ nodes: 4, edges: 5, embeddings: 0 });
    expect(state.currentMeta.embeddingCheckpoint).toBeUndefined();
  });

  it('retains the checkpoint when strict stats rejects', async () => {
    const message = 'strict graph count failed';
    state.currentMeta = makeMeta(LIVE_DIGEST);
    state.currentMeta.embeddingCheckpoint = {
      ...state.currentMeta.embeddingCheckpoint!,
      nodesProcessed: 0,
      totalNodes: 0,
      provider: undefined,
      physicalRows: undefined,
      validRows: undefined,
      recoverableIdentitySha256: undefined,
    };
    state.liveIntegrity = makeIntegrity(LIVE_DIGEST, 0);
    state.executeQuery.mockResolvedValue([]);
    state.getStrictLbugStats.mockRejectedValueOnce(new Error(message));
    const checkpointBefore = JSON.stringify(state.currentMeta.embeddingCheckpoint);

    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    const job = await waitForTerminalJob(baseUrl, jobId);

    expect(job).toMatchObject({ status: 'failed', error: message });
    expect(state.saveMeta).not.toHaveBeenCalled();
    expect(JSON.stringify(state.currentMeta.embeddingCheckpoint)).toBe(checkpointBefore);
  });

  it('runs the pipeline after read-only proof finds current graph nodes', async () => {
    state.currentMeta = makeMeta(LIVE_DIGEST);
    state.currentMeta.embeddingCheckpoint = {
      ...state.currentMeta.embeddingCheckpoint!,
      nodesProcessed: 0,
      totalNodes: 0,
      provider: undefined,
      physicalRows: undefined,
      validRows: undefined,
      recoverableIdentitySha256: undefined,
    };
    state.liveIntegrity = makeIntegrity(LIVE_DIGEST, 0);
    state.executeQuery.mockResolvedValue([{ id: 'Function:current' }]);
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    expect((await waitForTerminalJob(baseUrl, jobId)).status).toBe('complete');
    expect(state.openModes).toEqual([true, undefined]);
    expect(state.runEmbeddingPipeline).toHaveBeenCalledOnce();
    expect(state.getActiveEmbeddingIdentity).toHaveBeenCalledOnce();
    expect(state.inspectEmbeddingIntegrity).toHaveBeenCalledTimes(3);
    expect(state.inspectEmbeddingIntegrity.mock.invocationCallOrder[1]).toBeLessThan(
      state.getActiveEmbeddingIdentity.mock.invocationCallOrder[0],
    );
  });

  it('refuses provider-less durable proof when recorded rows vanished', async () => {
    state.currentMeta = makeMeta(MISMATCHED_DIGEST);
    state.currentMeta.embeddingCheckpoint = {
      ...state.currentMeta.embeddingCheckpoint!,
      nodesProcessed: 0,
      totalNodes: 0,
      provider: undefined,
    };
    state.liveIntegrity = makeIntegrity(LIVE_DIGEST, 0);
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    const job = await waitForTerminalJob(baseUrl, jobId);

    expect(job.error).toMatch(
      /unknown-provider|failed embedding integrity validation|durable identity/i,
    );
    expect(job.error).toMatch(/do not retry POST \/api\/embed/i);
    expect(job.error).toMatch(/gitnexus analyze --force --drop-embeddings --embeddings 0/);
    expect(job.error).not.toMatch(/POST \/api\/analyze/);
    expect(state.withLbugDb).not.toHaveBeenCalled();
    expect(state.runEmbeddingPipeline).not.toHaveBeenCalled();
    expect(state.saveMeta).not.toHaveBeenCalled();
  });

  it('completes an empty current graph without initializing embedding runtime', async () => {
    state.currentMeta = makeMeta(LIVE_DIGEST);
    state.currentMeta.embeddingCheckpoint = {
      ...state.currentMeta.embeddingCheckpoint!,
      nodesProcessed: 0,
      totalNodes: 0,
      provider: undefined,
      physicalRows: 0,
      validRows: 0,
    };
    state.liveIntegrity = makeIntegrity(LIVE_DIGEST, 0);
    state.graphNodes = [];
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };

    expect((await waitForTerminalJob(baseUrl, jobId)).status).toBe('complete');
    expect(state.executeQuery).toHaveBeenCalled();
    expect(state.executeQuery.mock.calls.every(([query]) => query.startsWith('MATCH (n:'))).toBe(
      true,
    );
    expect(state.getActiveEmbeddingIdentity).not.toHaveBeenCalled();
    expect(state.runEmbeddingPipeline).not.toHaveBeenCalled();
    expect(state.currentMeta.stats?.embeddings).toBe(0);
    expect(state.currentMeta.embeddingCheckpoint).toBeUndefined();
  });

  it('publishes completion only after the writable session returns', async () => {
    state.currentMeta = makeMeta(LIVE_DIGEST);
    let sessionOperationFinished!: () => void;
    const operationFinished = new Promise<void>((resolve) => (sessionOperationFinished = resolve));
    let releaseSession!: () => void;
    const sessionRelease = new Promise<void>((resolve) => (releaseSession = resolve));
    state.withLbugDb.mockImplementationOnce(async (_dbPath, operation, options) => {
      state.openModes.push(options?.readOnly);
      await operation();
      sessionOperationFinished();
      await sessionRelease;
    });

    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    await operationFinished;
    const pending = (await (await fetch(`${baseUrl}/api/embed/${jobId}`)).json()) as {
      status: string;
    };
    expect(pending.status).not.toBe('complete');
    releaseSession();
    expect((await waitForTerminalJob(baseUrl, jobId)).status).toBe('complete');
  });

  it('fails after a writable session teardown error despite a successful terminal save', async () => {
    state.currentMeta = makeMeta(LIVE_DIGEST);
    state.withLbugDb.mockImplementationOnce(async (_dbPath, operation, options) => {
      state.openModes.push(options?.readOnly);
      await operation();
      throw new Error('writable session teardown failed');
    });

    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    const job = await waitForTerminalJob(baseUrl, jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toBe('writable session teardown failed');
    expect(state.currentMeta.embeddingCheckpoint).toBeUndefined();
  });

  it.each([
    'connection not found',
    'connection does not exist',
    'database not found',
    'database does not exist',
    'query not found',
    'query does not exist',
    'transaction not found',
    'transaction does not exist',
  ])('propagates %s and retains the checkpoint', async (message) => {
    state.currentMeta = makeMeta(MISMATCHED_DIGEST);
    state.currentMeta.embeddingCheckpoint = {
      ...state.currentMeta.embeddingCheckpoint!,
      nodesProcessed: 0,
      totalNodes: 0,
      provider: undefined,
      physicalRows: undefined,
      validRows: undefined,
      recoverableIdentitySha256: undefined,
    };
    state.liveIntegrity = makeIntegrity(LIVE_DIGEST, 0);
    state.graphNodes = [];
    state.executeQuery.mockImplementation(async () => {
      throw new Error(message);
    });
    const before = JSON.stringify(state.currentMeta.embeddingCheckpoint);
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    const job = await waitForTerminalJob(baseUrl, jobId);

    expect(job.status).toBe('failed');
    expect(job.error).toMatch(new RegExp(message));
    expect(state.runEmbeddingPipeline).not.toHaveBeenCalled();
    expect(state.getActiveEmbeddingIdentity).not.toHaveBeenCalled();
    expect(state.saveMeta).not.toHaveBeenCalled();
    expect(JSON.stringify(state.currentMeta.embeddingCheckpoint)).toBe(before);
  });

  it('finds a text-bearing File after a full invalid page without loading all rows', async () => {
    state.currentMeta = makeMeta(LIVE_DIGEST);
    state.currentMeta.embeddingCheckpoint = {
      ...state.currentMeta.embeddingCheckpoint!,
      nodesProcessed: 0,
      totalNodes: 0,
      provider: undefined,
      physicalRows: undefined,
      validRows: undefined,
      recoverableIdentitySha256: undefined,
    };
    state.liveIntegrity = makeIntegrity(LIVE_DIGEST, 0);
    state.graphNodes = [];
    const fileQueries: string[] = [];
    state.executeQuery.mockImplementation(async (...args: unknown[]) => {
      const query = String(args[0] ?? '');
      if (!query.includes('`File`')) {
        throw new Error('table LegacyNode does not exist');
      }
      fileQueries.push(query);
      expect(query).toMatch(/ORDER BY n\.id LIMIT 256$/);
      if (fileQueries.length % 2 === 1) {
        return Array.from({ length: 256 }, (_, index) => ({
          id: index === 255 ? "last-'\\id" : `invalid-${index}`,
          filePath: `invalid/${index}`,
          content: index % 2 === 0 ? '' : '[Binary file - content not stored]',
        }));
      }
      expect(query).toContain(`WHERE n.id > '${escapeCypherString("last-'\\id")}' `);
      return [
        { id: 'valid-file', filePath: 'src/valid.ts', content: 'export const valid = true;' },
      ];
    });

    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };

    expect((await waitForTerminalJob(baseUrl, jobId)).status).toBe('complete');
    expect(state.runEmbeddingPipeline).toHaveBeenCalledOnce();
    expect(fileQueries).toHaveLength(4);
    expect(fileQueries.every((query) => /ORDER BY n\.id LIMIT 256$/.test(query))).toBe(true);
  });

  it('continues when a valid File precedes a null-ID row', async () => {
    state.currentMeta = makeMeta(LIVE_DIGEST);
    state.currentMeta.embeddingCheckpoint = {
      ...state.currentMeta.embeddingCheckpoint!,
      nodesProcessed: 0,
      totalNodes: 0,
      provider: undefined,
      physicalRows: undefined,
      validRows: undefined,
      recoverableIdentitySha256: undefined,
    };
    state.liveIntegrity = makeIntegrity(LIVE_DIGEST, 0);
    state.graphNodes = [];
    state.executeQuery.mockImplementation(async (...args: unknown[]) => {
      const query = String(args[0] ?? '');
      if (!query.includes('`File`')) throw new Error('table LegacyNode does not exist');
      return [
        { id: 'valid-file', filePath: 'src/valid.ts', content: 'export const valid = true;' },
        { id: null, filePath: 'invalid/last.ts', content: '' },
      ];
    });

    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    expect((await waitForTerminalJob(baseUrl, jobId)).status).toBe('complete');
    expect(state.runEmbeddingPipeline).toHaveBeenCalledOnce();
  });

  it('observes cancellation while a bounded preflight page is pending', async () => {
    state.currentMeta = makeMeta(LIVE_DIGEST);
    state.currentMeta.embeddingCheckpoint = {
      ...state.currentMeta.embeddingCheckpoint!,
      nodesProcessed: 0,
      totalNodes: 0,
      provider: undefined,
      physicalRows: 0,
      validRows: 0,
    };
    state.liveIntegrity = makeIntegrity(LIVE_DIGEST, 0);
    state.graphNodes = [];
    let releasePage!: () => void;
    let pageStartedResolve!: () => void;
    const pageStarted = new Promise<void>((resolve) => {
      pageStartedResolve = resolve;
    });
    const pageReleased = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    state.executeQuery.mockImplementation(async (...args: unknown[]) => {
      const query = String(args[0] ?? '');
      if (!query.includes('`File`')) throw new Error('table LegacyNode does not exist');
      pageStartedResolve();
      await pageReleased;
      return [];
    });

    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    await pageStarted;
    expect((await fetch(`${baseUrl}/api/embed/${jobId}`, { method: 'DELETE' })).status).toBe(200);
    releasePage();

    expect((await waitForTerminalJob(baseUrl, jobId)).status).toBe('failed');
    expect(state.runEmbeddingPipeline).not.toHaveBeenCalled();
    expect(state.saveMeta).not.toHaveBeenCalled();
    expect(state.currentMeta.embeddingCheckpoint).toBeDefined();
  });

  it('uses database order when a high-BMP File precedes an emoji File', async () => {
    state.currentMeta = makeMeta(LIVE_DIGEST);
    state.currentMeta.embeddingCheckpoint = {
      at: REPO.indexedAt,
      nodesProcessed: 0,
      totalNodes: 0,
      chunksProcessed: 0,
      model: MODEL,
      dimensions: identity.dimensions,
      pendingNodeIds: [],
    };
    state.liveIntegrity = makeIntegrity(LIVE_DIGEST, 0);
    state.graphNodes = [];
    state.runEmbeddingPipeline.mockImplementationOnce(async () => {
      state.liveIntegrity = makeIntegrity(LIVE_DIGEST, 3);
    });
    const firstId = 'File:\uE000';
    const validId = 'File:😀';
    const fileQueries: string[] = [];
    state.executeQuery.mockImplementation(async (...args: unknown[]) => {
      const query = String(args[0] ?? '');
      if (!query.includes('`File`')) throw new Error('table LegacyNode does not exist');
      fileQueries.push(query);
      expect(query).toMatch(/ORDER BY n\.id LIMIT 256$/);
      if (fileQueries.length % 2 === 1) {
        return Array.from({ length: 256 }, (_, index) => ({
          id: index === 255 ? firstId : `File:invalid-${index}`,
          filePath: `invalid/${index}`,
          content: '',
        }));
      }
      expect(query).toContain(`WHERE n.id > '${escapeCypherString(firstId)}' `);
      return [{ id: validId, filePath: 'src/emoji.ts', content: 'export const emoji = true;' }];
    });

    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    expect((await waitForTerminalJob(baseUrl, jobId)).status).toBe('complete');
    expect(fileQueries).toHaveLength(4);
    expect(state.runEmbeddingPipeline).toHaveBeenCalledOnce();
    expect(state.getActiveEmbeddingIdentity).toHaveBeenCalledOnce();
    expect(state.currentMeta.stats?.embeddings).toBe(3);
    expect(state.currentMeta.embeddingCheckpoint).toBeUndefined();
  });

  it.each([
    'table LegacyNode does not exist',
    'column LegacyNode does not exist',
    'property content not found',
  ])('treats an all-invalid File scan as true empty for %s', async (schemaError) => {
    state.currentMeta = makeMeta(LIVE_DIGEST);
    state.currentMeta.embeddingCheckpoint = {
      at: REPO.indexedAt,
      nodesProcessed: 0,
      totalNodes: 0,
      chunksProcessed: 0,
      model: MODEL,
      dimensions: identity.dimensions,
      pendingNodeIds: [],
    };
    state.liveIntegrity = makeIntegrity(LIVE_DIGEST, 0);
    state.graphNodes = [];
    const fileQueries: string[] = [];
    state.executeQuery.mockImplementation(async (...args: unknown[]) => {
      const query = String(args[0] ?? '');
      if (!query.includes('`File`')) throw new Error(schemaError);
      fileQueries.push(query);
      if (fileQueries.length % 2 === 1) {
        return Array.from({ length: 256 }, (_, index) => ({
          id: `invalid-${index}`,
          filePath: `invalid/${index}`,
          content: index % 2 === 0 ? '' : '[Binary file - content not stored]',
        }));
      }
      return [];
    });

    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };

    expect((await waitForTerminalJob(baseUrl, jobId)).status).toBe('complete');
    expect(fileQueries).toHaveLength(4);
    expect(fileQueries[1]).toContain("WHERE n.id > 'invalid-255' ");
    expect(fileQueries[3]).toContain("WHERE n.id > 'invalid-255' ");
    expect(state.runEmbeddingPipeline).not.toHaveBeenCalled();
    expect(state.getActiveEmbeddingIdentity).not.toHaveBeenCalled();
    expect(state.currentMeta.stats?.embeddings).toBe(0);
    expect(state.openModes).toEqual([true, undefined]);
    expect(state.currentMeta.embeddingCheckpoint).toBeUndefined();
  });

  it('fails the preflight without opening writable Ladybug when graph proof errors', async () => {
    state.currentMeta.embeddingCheckpoint = {
      ...state.currentMeta.embeddingCheckpoint!,
      nodesProcessed: 0,
      totalNodes: 0,
      provider: undefined,
      physicalRows: undefined,
      validRows: undefined,
      recoverableIdentitySha256: undefined,
    };
    state.liveIntegrity = makeIntegrity(LIVE_DIGEST, 0);
    state.executeQuery.mockRejectedValue(new Error('preflight query failed'));
    const before = JSON.stringify(state.currentMeta.embeddingCheckpoint);
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    const job = await waitForTerminalJob(baseUrl, jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/preflight query failed/);
    expect(state.openModes).toEqual([true]);
    expect(state.closeLbug).toHaveBeenCalledOnce();
    expect(JSON.stringify(state.currentMeta.embeddingCheckpoint)).toBe(before);
  });
  it('persists completed-window identity before an interrupted finalization', async () => {
    state.currentMeta = makeMeta(LIVE_DIGEST);
    state.runEmbeddingPipeline.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[6] as {
        onCheckpoint: (checkpoint: {
          nodesProcessed: number;
          totalNodes: number;
          chunksProcessed: number;
        }) => Promise<void>;
      };
      await options.onCheckpoint({ nodesProcessed: 2, totalNodes: 4, chunksProcessed: 5 });
      throw new Error('simulated interruption after durable checkpoint');
    });

    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    expect((await waitForTerminalJob(baseUrl, jobId)).status).toBe('failed');

    const persisted = (await state.loadMeta()).embeddingCheckpoint;
    expect(persisted).toMatchObject({
      nodesProcessed: 2,
      totalNodes: 4,
      chunksProcessed: 5,
      physicalRows: 3,
      validRows: 3,
      recoverableIdentitySha256: LIVE_DIGEST,
      pendingNodeIds: [],
    });
  });

  it.each([
    { label: 'successful checkpoint commit', saveError: undefined },
    { label: 'failed checkpoint commit', saveError: 'checkpoint persistence failed' },
  ])('keeps checkpoint cancellation pending through a $label', async ({ saveError }) => {
    state.currentMeta = makeMeta(LIVE_DIGEST);
    const checkpointBefore = JSON.stringify(state.currentMeta.embeddingCheckpoint);
    let checkpointSaveStarted!: () => void;
    const checkpointSave = new Promise<void>((resolve) => (checkpointSaveStarted = resolve));
    let releaseSave!: () => void;
    const saveRelease = new Promise<void>((resolve) => (releaseSave = resolve));
    state.saveMeta.mockImplementation(async (_storagePath, next) => {
      if (next.embeddingCheckpoint?.nodesProcessed === 2) {
        checkpointSaveStarted();
        await saveRelease;
        if (saveError) throw new Error(saveError);
      }
      state.currentMeta = next;
    });
    let pipelineResumed = false;
    state.runEmbeddingPipeline.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[6] as {
        onCheckpoint: (checkpoint: {
          nodesProcessed: number;
          totalNodes: number;
          chunksProcessed: number;
        }) => Promise<void>;
      };
      await options.onCheckpoint({ nodesProcessed: 2, totalNodes: 4, chunksProcessed: 5 });
      pipelineResumed = true;
    });

    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    await checkpointSave;

    const deleteHandlerStarted = armDeleteHandlerSignal();
    let deleteSettled = false;
    const deleteResponse = fetch(`${baseUrl}/api/embed/${jobId}`, { method: 'DELETE' }).then(
      (result) => {
        deleteSettled = true;
        return result;
      },
    );
    await deleteHandlerStarted;
    expect(deleteSettled).toBe(false);
    const activeJob = (await (await fetch(`${baseUrl}/api/embed/${jobId}`)).json()) as {
      status: string;
    };
    expect(activeJob.status).not.toMatch(/complete|failed/);

    releaseSave();
    const deleted = await deleteResponse;
    expect(deleted.status).toBe(saveError ? 400 : 200);
    await expect(deleted.json()).resolves.toEqual(
      saveError
        ? { error: 'Job already failed' }
        : { id: jobId, status: 'failed', error: 'Cancelled by user' },
    );
    const job = await waitForTerminalJob(baseUrl, jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toBe(saveError ?? 'Cancelled by user');
    expect(pipelineResumed).toBe(false);
    if (saveError) {
      expect(JSON.stringify(state.currentMeta.embeddingCheckpoint)).toBe(checkpointBefore);
    } else {
      expect(state.currentMeta.embeddingCheckpoint).toMatchObject({
        nodesProcessed: 2,
        totalNodes: 4,
        chunksProcessed: 5,
      });
    }
  });

  it('keeps terminal cancellation pending until completion is published', async () => {
    state.currentMeta = makeMeta(LIVE_DIGEST);
    let terminalSaveStarted!: () => void;
    const terminalSave = new Promise<void>((resolve) => (terminalSaveStarted = resolve));
    let releaseSave!: () => void;
    const saveRelease = new Promise<void>((resolve) => (releaseSave = resolve));
    state.saveMeta.mockImplementation(async (_storagePath, next) => {
      if (next.embeddingCheckpoint === undefined) {
        terminalSaveStarted();
        await saveRelease;
      }
      state.currentMeta = next;
    });

    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    await terminalSave;

    const deleteHandlerStarted = armDeleteHandlerSignal();
    let deleteSettled = false;
    const deleteResponse = fetch(`${baseUrl}/api/embed/${jobId}`, { method: 'DELETE' }).then(
      (result) => {
        deleteSettled = true;
        return result;
      },
    );
    await deleteHandlerStarted;
    expect(deleteSettled).toBe(false);

    releaseSave();
    const deleted = await deleteResponse;
    expect(deleted.status).toBe(400);
    await expect(deleted.json()).resolves.toEqual({ error: 'Job already complete' });
    expect((await waitForTerminalJob(baseUrl, jobId)).status).toBe('complete');
  });

  it('keeps terminal cancellation pending until failure is published', async () => {
    state.currentMeta = makeMeta(LIVE_DIGEST);
    let terminalSaveStarted!: () => void;
    const terminalSave = new Promise<void>((resolve) => (terminalSaveStarted = resolve));
    let releaseSave!: () => void;
    const saveRelease = new Promise<void>((resolve) => (releaseSave = resolve));
    state.saveMeta.mockImplementation(async (_storagePath, next) => {
      if (next.embeddingCheckpoint === undefined) {
        terminalSaveStarted();
        await saveRelease;
        throw new Error('terminal persistence failed');
      }
      state.currentMeta = next;
    });

    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    await terminalSave;

    const deleteHandlerStarted = armDeleteHandlerSignal();
    let deleteSettled = false;
    const deleteResponse = fetch(`${baseUrl}/api/embed/${jobId}`, { method: 'DELETE' }).then(
      (result) => {
        deleteSettled = true;
        return result;
      },
    );
    await deleteHandlerStarted;
    expect(deleteSettled).toBe(false);

    releaseSave();
    const deleted = await deleteResponse;
    expect(deleted.status).toBe(400);
    await expect(deleted.json()).resolves.toEqual({ error: 'Job already failed' });
    const job = await waitForTerminalJob(baseUrl, jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toBe('terminal persistence failed');
  });
});
