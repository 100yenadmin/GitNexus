import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoMeta } from '../../storage/repo-manager.js';

const repo = {
  name: 'checkpoint-fixture',
  path: '/virtual/checkpoint-fixture',
  storagePath: '/virtual/checkpoint-fixture/.gitnexus',
  indexedAt: '2026-08-22T00:00:00.000Z',
  lastCommit: 'test-head',
};
const checkpoint: NonNullable<RepoMeta['embeddingCheckpoint']> = {
  at: repo.indexedAt,
  nodesProcessed: 0,
  totalNodes: 0,
  chunksProcessed: 0,
  model: 'test-model',
  dimensions: 384,
  pendingNodeIds: [],
};
const state = {
  meta: {
    repoPath: repo.path,
    lastCommit: repo.lastCommit,
    indexedAt: repo.indexedAt,
    stats: {},
    embeddingCheckpoint: checkpoint,
  },
  loadMeta: vi.fn(async () => state.meta),
  saveMeta: vi.fn(async (_path: string, next: typeof state.meta) => {
    state.meta = next;
  }),
  executeQuery: vi.fn(async () => {
    throw new Error('graph preflight failed');
  }),
  inspect: vi.fn(async () => ({
    tablePresent: true,
    physicalRows: 0,
    validRows: 0,
    recoverableRows: 0,
    emptyIdRows: 0,
    emptyNodeIdRows: 0,
    invalidChunkRows: 0,
    noncanonicalIdRows: 0,
    duplicateIdRows: 0,
    duplicateSemanticRows: 0,
    orphanRows: 0,
    wrongDimensionRows: 0,
  })),
  pipeline: vi.fn(),
  identity: vi.fn(),
  withLbugDb: vi.fn(async (_path: string, run: () => Promise<unknown>) => run()),
};

vi.doMock('../../storage/repo-manager.js', async () => ({
  ...(await vi.importActual<typeof import('../../storage/repo-manager.js')>(
    '../../storage/repo-manager.js',
  )),
  listRegisteredRepos: vi.fn(async () => [repo]),
  loadMeta: state.loadMeta,
  saveMeta: state.saveMeta,
}));
vi.doMock('../../core/lbug/lbug-adapter.js', () => ({
  executeQuery: state.executeQuery,
  executePrepared: vi.fn(async () => []),
  executeWithReusedStatement: vi.fn(async () => undefined),
  streamQuery: vi.fn(async () => undefined),
  flushWAL: vi.fn(async () => undefined),
  closeLbug: vi.fn(async () => undefined),
  withLbugDb: state.withLbugDb,
  isReadOnlyDbError: vi.fn(() => false),
  inspectEmbeddingIntegrity: state.inspect,
  embeddingIntegrityFailures: vi.fn(() => 0),
  fetchExistingEmbeddingHashes: vi.fn(async () => undefined),
}));
vi.doMock('../../core/embeddings/embedder.js', () => ({
  getActiveEmbeddingIdentity: state.identity,
}));
vi.doMock('../../core/embeddings/embedding-pipeline.js', () => ({
  runEmbeddingPipeline: state.pipeline,
}));
vi.doMock('../../mcp/local/local-backend.js', () => ({
  LocalBackend: class {
    async init() {}
    async disconnect() {}
  },
}));
vi.doMock('../mcp-http.js', () => ({ mountMCPEndpoints: () => async () => {} }));
vi.doMock('../analyze-launch.js', () => ({ createLaunchAnalysisWorker: () => () => {} }));
vi.doMock('../analyze-upload.js', () => ({
  createAnalyzeUploadHandler: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.doMock('../upload-sweep.js', () => ({ sweepStaleUploads: async () => {} }));

const port = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no test port'));
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
const terminal = async (url: string, id: string) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const body = (await (await fetch(`${url}/api/embed/${id}`)).json()) as {
      status: string;
      error?: string;
    };
    if (body.status === 'complete' || body.status === 'failed') return body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('job did not finish');
};

describe('POST /api/embed checkpoint recovery', () => {
  let url = '';
  let shutdown: (() => Promise<void>) | undefined;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let onceSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const originalOnce = process.once.bind(process);
    onceSpy = vi.spyOn(process, 'once').mockImplementation(((event: string, listener: Function) => {
      if (event === 'SIGTERM') {
        shutdown = listener as () => Promise<void>;
        return process;
      }
      return originalOnce(event, listener);
    }) as typeof process.once);
    const { createServer } = await import('../api.js');
    const testPort = await port();
    await createServer(testPort, '127.0.0.1');
    url = `http://127.0.0.1:${testPort}`;
  });

  beforeEach(() => {
    state.meta = {
      repoPath: repo.path,
      lastCommit: repo.lastCommit,
      indexedAt: repo.indexedAt,
      stats: {},
      embeddingCheckpoint: { ...checkpoint },
    };
    state.executeQuery.mockReset();
    state.executeQuery.mockImplementation(async () => {
      throw new Error('connection not found');
    });
    state.pipeline.mockReset();
    state.identity.mockReset();
    state.saveMeta.mockClear();
    state.withLbugDb.mockClear();
  });

  afterAll(async () => {
    onceSpy.mockRestore();
    await shutdown?.();
    exitSpy.mockRestore();
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
    state.executeQuery.mockImplementation(async () => {
      throw new Error(message);
    });
    const before = JSON.stringify(state.meta.embeddingCheckpoint);
    const response = await fetch(`${url}/api/embed`, {
      method: 'POST',
      body: JSON.stringify({ repo: repo.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    const job = await terminal(url, jobId);
    expect(response.status).toBe(202);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(new RegExp(message));
    expect(state.pipeline).not.toHaveBeenCalled();
    expect(state.identity).not.toHaveBeenCalled();
    expect(state.saveMeta).not.toHaveBeenCalled();
    expect(JSON.stringify(state.meta.embeddingCheckpoint)).toBe(before);
  });

  it('rejects an embedding identity mismatch before opening writable LadybugDB', async () => {
    state.meta.embeddingCheckpoint = {
      ...checkpoint,
      provider: 'persisted-provider',
    };
    state.identity.mockReturnValue({
      provider: 'active-provider',
      model: checkpoint.model,
      dimensions: checkpoint.dimensions,
    });
    const before = JSON.stringify(state.meta.embeddingCheckpoint);

    const response = await fetch(`${url}/api/embed`, {
      method: 'POST',
      body: JSON.stringify({ repo: repo.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    const job = await terminal(url, jobId);

    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/Cannot resume embedding checkpoint/);
    expect(state.identity).toHaveBeenCalledOnce();
    expect(state.withLbugDb).not.toHaveBeenCalled();
    expect(state.pipeline).not.toHaveBeenCalled();
    expect(state.saveMeta).not.toHaveBeenCalled();
    expect(JSON.stringify(state.meta.embeddingCheckpoint)).toBe(before);
  });
});
