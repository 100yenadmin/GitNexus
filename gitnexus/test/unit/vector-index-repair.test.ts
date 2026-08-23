import fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStoragePaths, saveMeta, type RepoMeta } from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

const cleanIntegrity = {
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
  recoverableIdentitySha256: 'a'.repeat(64),
};

async function importRepairSubject() {
  const initLbugReadOnlyNonRecovering = vi.fn(async () => undefined);
  const initLbugForMaintenance = vi.fn(async () => undefined);
  const dropVectorIndex = vi.fn(async () => true);
  const createVectorIndex = vi.fn(async () => true);
  const closeLbug = vi.fn(async () => undefined);
  const executeQuery = vi.fn(async (query: string) => {
    if (query.includes('CodeEmbedding')) throw new Error('connection does not exist');
    return [];
  });
  const inspectEmbeddingIntegrity = vi.fn(async () => cleanIntegrity);
  const withLbugDb = vi.fn(async (_path: string, operation: () => Promise<unknown>) => operation());
  const probeDoctorPool = vi.fn(async () => ({
    fts: true,
    vector: true,
    vectorIndex: false,
    vectorIndexReason: 'vector-index-missing-or-unqueryable',
    exercisedConnections: 8,
    connectionCount: 8,
    reason: null,
  }));
  vi.doMock('../../src/core/lbug/lbug-adapter.js', async (importActual) => ({
    ...(await importActual<typeof import('../../src/core/lbug/lbug-adapter.js')>()),
    initLbugReadOnlyNonRecovering,
    initLbugForMaintenance,
    dropVectorIndex,
    createVectorIndex,
    closeLbug,
    executeQuery,
    inspectEmbeddingIntegrity,
    getLbugStats: vi.fn(async () => ({ nodes: 0, edges: 0 })),
    withLbugDb,
  }));
  vi.doMock('../../src/cli/doctor-pool-probe.js', () => ({
    EXPECTED_POOL_CONNECTIONS: 8,
    probeDoctorPool,
  }));
  vi.doMock('../../src/core/staged-promotion.js', async (importActual) => ({
    ...(await importActual<typeof import('../../src/core/staged-promotion.js')>()),
    withAnalyzeOwnershipLock: vi.fn(async (_storagePath, callback) => callback()),
  }));
  return {
    ...(await import('../../src/core/run-analyze.js')),
    mocks: { dropVectorIndex, createVectorIndex },
  };
}

describe('VECTOR repair shared schema-error contract', () => {
  afterEach(() => {
    vi.doUnmock('../../src/core/lbug/lbug-adapter.js');
    vi.doUnmock('../../src/cli/doctor-pool-probe.js');
    vi.doUnmock('../../src/core/staged-promotion.js');
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('propagates a connection does-not-exist failure without clearing checkpoint metadata', async () => {
    const fixture = await createTempDir('gitnexus-test-');
    try {
      const paths = getStoragePaths(fixture.dbPath);
      await fs.mkdir(paths.storagePath, { recursive: true });
      await fs.writeFile(paths.lbugPath, 'fixture');
      const meta: RepoMeta = {
        repoPath: fixture.dbPath,
        lastCommit: '',
        indexedAt: '2026-08-23T00:00:00.000Z',
        stats: { files: 0, nodes: 0, edges: 0, embeddings: 0 },
        embeddingCheckpoint: {
          at: '2026-08-23T00:00:00.000Z',
          nodesProcessed: 0,
          totalNodes: 0,
          chunksProcessed: 0,
          model: 'Snowflake/snowflake-arctic-embed-xs',
          dimensions: 384,
          physicalRows: 0,
          validRows: 0,
          recoverableIdentitySha256: 'a'.repeat(64),
        },
      };
      await saveMeta(paths.storagePath, meta);
      const before = await fs.readFile(`${paths.storagePath}/gitnexus.json`);
      const { runFullAnalysis, mocks } = await importRepairSubject();

      await expect(
        runFullAnalysis(fixture.dbPath, { repairVector: true }, { onProgress: () => {} }),
      ).rejects.toThrow('connection does not exist');
      expect(mocks.dropVectorIndex).not.toHaveBeenCalled();
      expect(mocks.createVectorIndex).not.toHaveBeenCalled();
      await expect(fs.readFile(`${paths.storagePath}/gitnexus.json`)).resolves.toEqual(before);
    } finally {
      await fixture.cleanup();
    }
  });
});
