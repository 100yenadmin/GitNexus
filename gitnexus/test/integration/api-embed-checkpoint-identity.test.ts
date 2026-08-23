import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingIntegrityReport } from '../../src/core/lbug/lbug-adapter.js';
import type { RegistryEntry, RepoMeta } from '../../src/storage/repo-manager.js';
import { escapeCypherString } from '../../src/core/lbug/cypher-escape.js';

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
const makeIntegrity = (digest: string, physicalRows = 3): EmbeddingIntegrityReport =>
  ({
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

const makeMeta = (digest: string): RepoMeta => ({
  repoPath: REPO.path,
  lastCommit: REPO.lastCommit,
  indexedAt: REPO.indexedAt,
  stats: { embeddings: 3 },
  embeddingCheckpoint: {
    at: REPO.indexedAt,
    nodesProcessed: 1,
    totalNodes: 2,
    chunksProcessed: 3,
    ...identity,
    physicalRows: 3,
    validRows: 3,
    recoverableIdentitySha256: digest,
    pendingNodeIds: [],
  },
});

const state = {
  currentMeta: makeMeta(MISMATCHED_DIGEST),
  liveIntegrity: makeIntegrity(LIVE_DIGEST),
  graphNodes: [{ id: 'node-1' }],
  executeQuery: vi.fn(async () => state.graphNodes),
  getActiveEmbeddingIdentity: vi.fn(() => identity),
  runEmbeddingPipeline: vi.fn(async (..._args: unknown[]) => undefined),
  inspectEmbeddingIntegrity: vi.fn(async () => state.liveIntegrity),
  saveMeta: vi.fn(async (_storagePath: string, next: RepoMeta) => {
    state.currentMeta = next;
  }),
  loadMeta: vi.fn(async () => state.currentMeta),
  listRegisteredRepos: vi.fn(async () => [REPO]),
};

vi.doMock('../../src/storage/repo-manager.js', async () => ({
  ...(await vi.importActual<typeof import('../../src/storage/repo-manager.js')>(
    '../../src/storage/repo-manager.js',
  )),
  listRegisteredRepos: state.listRegisteredRepos,
  loadMeta: state.loadMeta,
  saveMeta: state.saveMeta,
}));

vi.doMock('../../src/core/lbug/lbug-adapter.js', async () => ({
  executeQuery: state.executeQuery,
  executePrepared: vi.fn(async () => []),
  executeWithReusedStatement: vi.fn(async () => undefined),
  streamQuery: vi.fn(async () => undefined),
  flushWAL: vi.fn(async () => undefined),
  closeLbug: vi.fn(async () => undefined),
  withLbugDb: vi.fn(async (_dbPath: string, operation: () => Promise<unknown>) => operation()),
  isReadOnlyDbError: vi.fn(() => false),
  queryFTS: vi.fn(async () => []),
  inspectEmbeddingIntegrity: state.inspectEmbeddingIntegrity,
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
  createLaunchAnalysisWorker: () => (): void => {},
}));
vi.doMock('../../src/server/analyze-upload.js', () => ({
  createAnalyzeUploadHandler: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.doMock('../../src/server/upload-sweep.js', () => ({
  sweepStaleUploads: async (): Promise<void> => {},
}));

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

describe('POST /api/embed completed-checkpoint identity', () => {
  let baseUrl = '';
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

    const { createServer } = await import('../../src/server/api.js');
    const port = await allocatePort();
    await createServer(port, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${port}`;
  });

  beforeEach(() => {
    state.currentMeta = makeMeta(MISMATCHED_DIGEST);
    state.liveIntegrity = makeIntegrity(LIVE_DIGEST);
    state.graphNodes = [{ id: 'node-1' }];
    state.executeQuery.mockClear();
    state.getActiveEmbeddingIdentity.mockClear();
    state.runEmbeddingPipeline.mockReset();
    state.runEmbeddingPipeline.mockResolvedValue(undefined);
    state.saveMeta.mockClear();
  });

  afterAll(async () => {
    onceSpy.mockRestore();
    await shutdown?.();
    exitSpy.mockRestore();
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

  it('accepts a matching digest and finalizes clean metadata', async () => {
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
    expect(state.runEmbeddingPipeline).toHaveBeenCalledOnce();
    expect(state.currentMeta.stats?.embeddings).toBe(3);
    expect(state.currentMeta.embeddingCheckpoint).toBeUndefined();
  });

  it('gives legacy checkpoints an explicit recovery action instead of a blind retry', async () => {
    state.currentMeta.embeddingCheckpoint = {
      ...state.currentMeta.embeddingCheckpoint!,
      provider: undefined,
    };
    const before = JSON.stringify(state.currentMeta.embeddingCheckpoint);
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    const job = await waitForTerminalJob(baseUrl, jobId);

    expect(job.error).toMatch(/unknown-provider/);
    expect(job.error).toMatch(/do not retry POST \/api\/embed/i);
    expect(job.error).toMatch(/gitnexus analyze --force --drop-embeddings --embeddings/);
    expect(JSON.stringify(state.currentMeta.embeddingCheckpoint)).toBe(before);
  });

  it('clears a legacy zero-node checkpoint and runs a fresh pipeline for current graph nodes', async () => {
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
    state.liveIntegrity = { ...state.liveIntegrity, physicalRows: 0, validRows: 0 };
    state.graphNodes = [{ id: 'node-1' }, { id: 'node-2' }];
    state.runEmbeddingPipeline.mockImplementationOnce(async (executeQuery) => {
      expect(await (executeQuery as () => Promise<unknown[]>)()).toEqual(state.graphNodes);
    });
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO.name }),
    });
    const { jobId } = (await response.json()) as { jobId: string };
    expect((await waitForTerminalJob(baseUrl, jobId)).status).toBe('complete');
    expect(state.executeQuery).toHaveBeenCalled();
    expect(state.getActiveEmbeddingIdentity).toHaveBeenCalledOnce();
    expect(state.runEmbeddingPipeline).toHaveBeenCalledOnce();
    expect(state.currentMeta.embeddingCheckpoint).toBeUndefined();
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

    expect(job.error).toMatch(/failed embedding integrity validation|durable identity/i);
    expect(job.error).toMatch(/do not retry POST \/api\/embed/i);
    expect(job.error).toMatch(/gitnexus analyze --force --drop-embeddings --embeddings/);
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
    expect(
      state.executeQuery.mock.calls.every(([query]) => query.startsWith('MATCH (n:')),
    ).toBe(true);
    expect(state.getActiveEmbeddingIdentity).not.toHaveBeenCalled();
    expect(state.runEmbeddingPipeline).not.toHaveBeenCalled();
    expect(state.currentMeta.stats?.embeddings).toBe(0);
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
  ])
    ('propagates %s and retains the checkpoint', async (message) => {
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
      if (fileQueries.length === 1) {
        return Array.from({ length: 256 }, (_, index) => ({
          id: index === 255 ? "last-'\\id" : `invalid-${index}`,
          filePath: `invalid/${index}`,
          content: index % 2 === 0 ? '' : '[Binary file - content not stored]',
        }));
      }
      expect(query).toContain(`WHERE n.id > '${escapeCypherString("last-'\\id")}' `);
      if (fileQueries.length === 2) {
        return [{ id: 'valid-file', filePath: 'src/valid.ts', content: 'export const valid = true;' }];
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
    expect(state.runEmbeddingPipeline).toHaveBeenCalledOnce();
    expect(fileQueries).toHaveLength(2);
    expect(fileQueries.every((query) => /ORDER BY n\.id LIMIT 256$/.test(query))).toBe(true);
  });

  it.each([
    'table LegacyNode does not exist',
    'column LegacyNode does not exist',
    'property content not found',
  ])('treats an all-invalid File scan as true empty for %s', async (schemaError) => {
    state.currentMeta = makeMeta(LIVE_DIGEST);
    state.currentMeta.embeddingCheckpoint = undefined;
    state.liveIntegrity = makeIntegrity(LIVE_DIGEST, 0);
    state.graphNodes = [];
    const fileQueries: string[] = [];
    state.executeQuery.mockImplementation(async (...args: unknown[]) => {
      const query = String(args[0] ?? '');
      if (!query.includes('`File`')) throw new Error(schemaError);
      fileQueries.push(query);
      if (fileQueries.length === 1) {
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
    expect(fileQueries).toHaveLength(2);
    expect(fileQueries[1]).toContain("WHERE n.id > 'invalid-255' ");
    expect(state.runEmbeddingPipeline).not.toHaveBeenCalled();
    expect(state.getActiveEmbeddingIdentity).not.toHaveBeenCalled();
    expect(state.currentMeta.stats?.embeddings).toBe(0);
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
});
