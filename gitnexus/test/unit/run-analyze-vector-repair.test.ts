import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getStoragePaths,
  saveMeta,
  INCREMENTAL_SCHEMA_VERSION,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

const healthyProbe = {
  fts: true,
  vector: true,
  vectorIndex: true,
  vectorIndexReason: null,
  exercisedConnections: 8,
  connectionCount: 8,
  reason: null,
} as const;

const brokenProbe = {
  ...healthyProbe,
  vectorIndex: false,
  vectorIndexReason: 'vector-index-missing-or-unqueryable' as const,
};

async function createIndexedFixture(embeddings = 3, metaExtras: Partial<RepoMeta> = {}) {
  const fixture = await createTempDir('gitnexus-vector-repair-');
  const paths = getStoragePaths(fixture.dbPath);
  await fs.mkdir(paths.storagePath, { recursive: true });
  await fs.writeFile(paths.lbugPath, 'fixture');
  const meta: RepoMeta = {
    repoPath: fixture.dbPath,
    lastCommit: '',
    indexedAt: '2026-07-22T00:00:00.000Z',
    stats: { files: 2, nodes: 5, edges: 4, embeddings },
    capabilities: {
      graph: { provider: 'ladybugdb', status: 'available' },
      fts: { provider: 'ladybugdb-fts', status: 'available' },
      vectorSearch: {
        provider: 'exact-scan',
        status: 'exact-scan',
        exactScanLimit: 20_000,
      },
    },
    ...metaExtras,
  };
  await saveMeta(paths.storagePath, meta);
  return { fixture, paths, meta };
}

// Matches the identity resolveEmbeddingIdentity() yields when no
// GITNEXUS_EMBEDDING_* env is set (DEFAULT_EMBEDDING_CONFIG, local mode).
const completedCheckpoint = {
  at: '2026-08-19T14:39:59.336Z',
  nodesProcessed: 5,
  totalNodes: 5,
  chunksProcessed: 6,
  provider: 'local',
  model: 'Snowflake/snowflake-arctic-embed-xs',
  dimensions: 384,
} as const;

const EMBEDDING_ENV_KEYS = [
  'GITNEXUS_EMBEDDING_MODEL',
  'GITNEXUS_EMBEDDING_URL',
  'GITNEXUS_EMBEDDING_DIMS',
] as const;

function pinDefaultEmbeddingIdentity() {
  const saved = EMBEDDING_ENV_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of EMBEDDING_ENV_KEYS) delete process.env[key];
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function importRepairSubject(options: {
  counts?: number[];
  probes?: Array<typeof healthyProbe | typeof brokenProbe>;
  vectorAvailable?: boolean;
  createError?: Error;
  missingEmbeddingTable?: boolean;
  malformedEmbeddingTable?: boolean;
  identityDigest?: string;
  registered?: boolean;
  afterInitialPreflight?: () => Promise<void> | void;
}) {
  const counts = [...(options.counts ?? [3, 3, 3, 3])];
  const probes = [...(options.probes ?? [brokenProbe, healthyProbe])];
  const initLbugReadOnlyNonRecovering = vi.fn(async () => undefined);
  const initLbugForMaintenance = vi.fn(async () => undefined);
  const loadVectorExtension = vi.fn(async () => options.vectorAvailable ?? true);
  const dropVectorIndex = vi.fn(async () => true);
  const createVectorIndex = vi.fn(async () => {
    if (options.createError) throw options.createError;
    return true;
  });
  const closeLbug = vi.fn(async () => undefined);
  let embeddingCountQueries = 0;
  let lastEmbeddingCount = counts[0] ?? 0;
  const executeQuery = vi.fn(async (query: string) => {
    if (!query.includes('CodeEmbedding')) return [];
    embeddingCountQueries++;
    if (options.missingEmbeddingTable && embeddingCountQueries === 1) {
      throw new Error('Binder exception: Table CodeEmbedding does not exist.');
    }
    lastEmbeddingCount = counts.shift() ?? 0;
    return [{ cnt: lastEmbeddingCount }];
  });
  const inspectEmbeddingIntegrity = vi.fn(async () => ({
    tablePresent: true,
    physicalRows: lastEmbeddingCount,
    validRows: options.malformedEmbeddingTable
      ? Math.max(0, lastEmbeddingCount - 1)
      : lastEmbeddingCount,
    recoverableRows: options.malformedEmbeddingTable
      ? Math.max(0, lastEmbeddingCount - 1)
      : lastEmbeddingCount,
    emptyIdRows: options.malformedEmbeddingTable ? 1 : 0,
    emptyNodeIdRows: 0,
    invalidChunkRows: 0,
    noncanonicalIdRows: 0,
    duplicateIdRows: 0,
    duplicateSemanticRows: 0,
    orphanRows: 0,
    wrongDimensionRows: 0,
    recoverableIdentitySha256: options.identityDigest ?? 'a'.repeat(64),
    physicalRowsSha256: options.identityDigest ?? 'a'.repeat(64),
  }));
  const withLbugDb = vi.fn(async (_dbPath: string, operation: () => Promise<unknown>) =>
    operation(),
  );
  const registerRepo = vi.fn(async () => 'fixture-repo');
  const isRepoRegistered = vi.fn(async () => options.registered ?? true);
  const probeDoctorPool = vi.fn(async () => probes.shift() ?? healthyProbe);
  vi.doMock('../../src/core/lbug/lbug-adapter.js', async (importActual) => ({
    ...(await importActual<typeof import('../../src/core/lbug/lbug-adapter.js')>()),
    initLbugReadOnlyNonRecovering,
    initLbugForMaintenance,
    loadVectorExtension,
    dropVectorIndex,
    createVectorIndex,
    closeLbug,
    getLbugStats: vi.fn(async () => ({ nodes: 5, edges: 4 })),
    executeQuery,
    inspectEmbeddingIntegrity,
    withLbugDb,
  }));
  vi.doMock('../../src/cli/doctor-pool-probe.js', () => ({
    EXPECTED_POOL_CONNECTIONS: 8,
    probeDoctorPool,
  }));
  vi.doMock('../../src/core/staged-promotion.js', async (importActual) => {
    const actual = await importActual<typeof import('../../src/core/staged-promotion.js')>();
    return {
      ...actual,
      withAnalyzeOwnershipLock: vi.fn(async (_storagePath, callback) => {
        const ownershipLock = path.join(_storagePath, 'analyze-staged.lock');
        await fs.writeFile(ownershipLock, 'owned-by-test');
        try {
          await options.afterInitialPreflight?.();
          return await callback();
        } finally {
          await fs.rm(ownershipLock, { force: true });
        }
      }),
    };
  });
  vi.doMock('../../src/storage/repo-manager.js', async (importActual) => ({
    ...(await importActual<typeof import('../../src/storage/repo-manager.js')>()),
    registerRepo,
    isRepoRegistered,
  }));

  const subject = await import('../../src/core/run-analyze.js');
  return {
    ...subject,
    mocks: {
      initLbugReadOnlyNonRecovering,
      initLbugForMaintenance,
      loadVectorExtension,
      dropVectorIndex,
      createVectorIndex,
      closeLbug,
      executeQuery,
      inspectEmbeddingIntegrity,
      withLbugDb,
      registerRepo,
      isRepoRegistered,
      probeDoctorPool,
    },
  };
}

describe('runFullAnalysis VECTOR-only repair (#170)', () => {
  afterEach(() => {
    vi.doUnmock('../../src/core/lbug/lbug-adapter.js');
    vi.doUnmock('../../src/cli/doctor-pool-probe.js');
    vi.doUnmock('../../src/core/staged-promotion.js');
    vi.doUnmock('../../src/storage/repo-manager.js');
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('inspects live rows on the same-commit path when legacy metadata reports zero', async () => {
    const indexed = await createIndexedFixture(0, {
      schemaVersion: INCREMENTAL_SCHEMA_VERSION,
    });
    try {
      execSync('git init', { cwd: indexed.fixture.dbPath, stdio: 'pipe' });
      execSync('git -c user.name=test -c user.email=test@test commit --allow-empty -m init', {
        cwd: indexed.fixture.dbPath,
        stdio: 'pipe',
      });
      const currentCommit = execSync('git rev-parse HEAD', {
        cwd: indexed.fixture.dbPath,
        encoding: 'utf8',
      }).trim();
      await saveMeta(indexed.paths.storagePath, { ...indexed.meta, lastCommit: currentCommit });

      const { runFullAnalysis, mocks } = await importRepairSubject({
        counts: [1],
        malformedEmbeddingTable: true,
      });
      await expect(
        runFullAnalysis(indexed.fixture.dbPath, {}, { onProgress: () => {} }),
      ).rejects.toThrow(/Already-up-to-date index failed embedding integrity validation/i);
      expect(mocks.withLbugDb).toHaveBeenCalledWith(
        indexed.paths.lbugPath,
        mocks.inspectEmbeddingIntegrity,
        { readOnly: true },
      );
    } finally {
      await indexed.fixture.cleanup();
    }
  });

  it('rebuilds only HNSW, preserves the embedding count, then reconciles metadata', async () => {
    const indexed = await createIndexedFixture();
    try {
      const { runFullAnalysis, mocks } = await importRepairSubject({});
      const result = await runFullAnalysis(
        indexed.fixture.dbPath,
        { repairVector: true },
        { onProgress: () => {} },
      );

      expect(result.vectorRepairStatus).toBe('repaired');
      expect(mocks.dropVectorIndex).toHaveBeenCalledOnce();
      expect(mocks.createVectorIndex).toHaveBeenCalledOnce();
      expect(mocks.probeDoctorPool).toHaveBeenCalledTimes(2);
      expect(mocks.executeQuery.mock.calls.map(([query]) => query)).toEqual([
        expect.stringMatching(/MATCH \(e:CodeEmbedding\).*count/i),
        expect.stringMatching(/MATCH \(e:CodeEmbedding\).*count/i),
        expect.stringMatching(/MATCH \(e:CodeEmbedding\).*count/i),
        expect.stringMatching(/MATCH \(e:CodeEmbedding\).*count/i),
      ]);
      expect(mocks.initLbugReadOnlyNonRecovering).toHaveBeenCalledWith(indexed.paths.lbugPath);
      expect(mocks.registerRepo).toHaveBeenCalledOnce();

      const repaired = JSON.parse(
        await fs.readFile(path.join(indexed.paths.storagePath, 'gitnexus.json'), 'utf8'),
      );
      expect(repaired.stats).toMatchObject({ nodes: 5, edges: 4, embeddings: 3 });
      expect(repaired.capabilities.vectorSearch.status).toBe('vector-index');
    } finally {
      await indexed.fixture.cleanup();
    }
  });

  it('returns not-indexed without rebuilding or changing metadata when there are zero rows', async () => {
    const indexed = await createIndexedFixture(0);
    try {
      const before = await fs.readFile(path.join(indexed.paths.storagePath, 'gitnexus.json'));
      const { runFullAnalysis, mocks } = await importRepairSubject({ counts: [0] });
      const result = await runFullAnalysis(
        indexed.fixture.dbPath,
        { repairVector: true },
        { onProgress: () => {} },
      );

      expect(result.vectorRepairStatus).toBe('not-indexed');
      expect(mocks.loadVectorExtension).not.toHaveBeenCalled();
      expect(mocks.dropVectorIndex).not.toHaveBeenCalled();
      expect(mocks.createVectorIndex).not.toHaveBeenCalled();
      expect(mocks.registerRepo).not.toHaveBeenCalled();
      expect(mocks.initLbugForMaintenance).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(indexed.paths.storagePath, 'gitnexus.json'))).toEqual(
        before,
      );
    } finally {
      await indexed.fixture.cleanup();
    }
  });

  it('refuses malformed embedding identity before HNSW or metadata mutation', async () => {
    const indexed = await createIndexedFixture();
    try {
      const before = await fs.readFile(path.join(indexed.paths.storagePath, 'gitnexus.json'));
      const { runFullAnalysis, mocks } = await importRepairSubject({
        malformedEmbeddingTable: true,
      });
      await expect(
        runFullAnalysis(indexed.fixture.dbPath, { repairVector: true }, { onProgress: () => {} }),
      ).rejects.toThrow(/source table failed embedding integrity validation/i);
      expect(mocks.dropVectorIndex).not.toHaveBeenCalled();
      expect(mocks.createVectorIndex).not.toHaveBeenCalled();
      expect(mocks.registerRepo).not.toHaveBeenCalled();
      expect(mocks.probeDoctorPool).not.toHaveBeenCalled();
      expect(mocks.initLbugForMaintenance).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(indexed.paths.storagePath, 'gitnexus.json'))).toEqual(
        before,
      );
    } finally {
      await indexed.fixture.cleanup();
    }
  });

  it('treats a missing CodeEmbedding table as not indexed without mutation', async () => {
    const indexed = await createIndexedFixture(0);
    try {
      const before = await fs.readFile(path.join(indexed.paths.storagePath, 'gitnexus.json'));
      const { runFullAnalysis, mocks } = await importRepairSubject({
        missingEmbeddingTable: true,
      });
      const result = await runFullAnalysis(
        indexed.fixture.dbPath,
        { repairVector: true },
        { onProgress: () => {} },
      );
      expect(result.vectorRepairStatus).toBe('not-indexed');
      expect(mocks.dropVectorIndex).not.toHaveBeenCalled();
      expect(mocks.registerRepo).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(indexed.paths.storagePath, 'gitnexus.json'))).toEqual(
        before,
      );
    } finally {
      await indexed.fixture.cleanup();
    }
  });

  it('fails closed when the production pool cannot prove VECTOR before repair', async () => {
    const indexed = await createIndexedFixture();
    try {
      const unavailableProbe = {
        ...brokenProbe,
        vector: false,
        reason: 'vector-extension-unavailable',
      };
      const { runFullAnalysis, mocks } = await importRepairSubject({
        probes: [unavailableProbe],
      });
      await expect(
        runFullAnalysis(indexed.fixture.dbPath, { repairVector: true }, { onProgress: () => {} }),
      ).rejects.toThrow(/could not prove VECTOR availability/i);
      expect(mocks.dropVectorIndex).not.toHaveBeenCalled();
      expect(mocks.createVectorIndex).not.toHaveBeenCalled();
      expect(mocks.registerRepo).not.toHaveBeenCalled();
    } finally {
      await indexed.fixture.cleanup();
    }
  });

  it('does not drop HNSW when VECTOR support is unavailable', async () => {
    const indexed = await createIndexedFixture();
    try {
      const before = await fs.readFile(path.join(indexed.paths.storagePath, 'gitnexus.json'));
      const { runFullAnalysis, mocks } = await importRepairSubject({ vectorAvailable: false });
      await expect(
        runFullAnalysis(indexed.fixture.dbPath, { repairVector: true }, { onProgress: () => {} }),
      ).rejects.toThrow(/VECTOR extension is unavailable/i);
      expect(mocks.dropVectorIndex).not.toHaveBeenCalled();
      expect(mocks.createVectorIndex).not.toHaveBeenCalled();
      expect(mocks.registerRepo).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(indexed.paths.storagePath, 'gitnexus.json'))).toEqual(
        before,
      );
    } finally {
      await indexed.fixture.cleanup();
    }
  });

  it('leaves metadata and registry untouched when HNSW recreation fails', async () => {
    const indexed = await createIndexedFixture();
    try {
      const before = await fs.readFile(path.join(indexed.paths.storagePath, 'gitnexus.json'));
      const { runFullAnalysis, mocks } = await importRepairSubject({
        createError: new Error('simulated HNSW failure'),
      });
      await expect(
        runFullAnalysis(indexed.fixture.dbPath, { repairVector: true }, { onProgress: () => {} }),
      ).rejects.toThrow(/simulated HNSW failure/);
      expect(mocks.registerRepo).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(indexed.paths.storagePath, 'gitnexus.json'))).toEqual(
        before,
      );
    } finally {
      await indexed.fixture.cleanup();
    }
  });

  it('does not rebuild a healthy HNSW index but still verifies and reconciles counts', async () => {
    const indexed = await createIndexedFixture();
    try {
      const { runFullAnalysis, mocks } = await importRepairSubject({
        probes: [healthyProbe, healthyProbe],
      });
      const result = await runFullAnalysis(
        indexed.fixture.dbPath,
        { repairVector: true },
        { onProgress: () => {} },
      );
      expect(result.vectorRepairStatus).toBe('healthy');
      expect(mocks.dropVectorIndex).not.toHaveBeenCalled();
      expect(mocks.createVectorIndex).not.toHaveBeenCalled();
      expect(mocks.registerRepo).toHaveBeenCalledOnce();
    } finally {
      await indexed.fixture.cleanup();
    }
  });

  it('refuses active recovery sidecars before opening the database', async () => {
    const indexed = await createIndexedFixture();
    try {
      await fs.writeFile(`${indexed.paths.lbugPath}.wal`, 'unresolved');
      const { runFullAnalysis, mocks } = await importRepairSubject({});
      await expect(
        runFullAnalysis(indexed.fixture.dbPath, { repairVector: true }, { onProgress: () => {} }),
      ).rejects.toThrow(/lock or recovery state is present/i);
      expect(mocks.initLbugForMaintenance).not.toHaveBeenCalled();
    } finally {
      await indexed.fixture.cleanup();
    }
  });

  it('rechecks recovery state after acquiring analyze ownership', async () => {
    const indexed = await createIndexedFixture();
    try {
      const { runFullAnalysis, mocks } = await importRepairSubject({
        afterInitialPreflight: async () => {
          await fs.writeFile(`${indexed.paths.lbugPath}.wal`, 'intervening-writer');
        },
      });
      await expect(
        runFullAnalysis(indexed.fixture.dbPath, { repairVector: true }, { onProgress: () => {} }),
      ).rejects.toThrow(/lock or recovery state is present/i);
      expect(mocks.initLbugForMaintenance).not.toHaveBeenCalled();
    } finally {
      await indexed.fixture.cleanup();
    }
  });

  it('refuses repair while an incremental analysis is in progress', async () => {
    const indexed = await createIndexedFixture(3, {
      incrementalInProgress: { startedAt: 1_787_151_443_267, toWriteCount: 0 },
    });
    try {
      const { runFullAnalysis, mocks } = await importRepairSubject({});
      await expect(
        runFullAnalysis(indexed.fixture.dbPath, { repairVector: true }, { onProgress: () => {} }),
      ).rejects.toThrow(/incomplete analysis or embedding checkpoint/i);
      expect(mocks.initLbugForMaintenance).not.toHaveBeenCalled();
    } finally {
      await indexed.fixture.cleanup();
    }
  });

  it('refuses repair while an embedding checkpoint has unprocessed nodes', async () => {
    const indexed = await createIndexedFixture(3, {
      embeddingCheckpoint: { ...completedCheckpoint, nodesProcessed: 3 },
    });
    try {
      const { runFullAnalysis, mocks } = await importRepairSubject({});
      await expect(
        runFullAnalysis(indexed.fixture.dbPath, { repairVector: true }, { onProgress: () => {} }),
      ).rejects.toThrow(/incomplete analysis or embedding checkpoint/i);
      expect(mocks.initLbugForMaintenance).not.toHaveBeenCalled();
    } finally {
      await indexed.fixture.cleanup();
    }
  });

  it('refuses repair while a complete-count checkpoint still has a pending window', async () => {
    const indexed = await createIndexedFixture(3, {
      embeddingCheckpoint: {
        ...completedCheckpoint,
        pendingNodeIds: ['Function:src/auth.ts:validateToken'],
      },
    });
    try {
      const { runFullAnalysis, mocks } = await importRepairSubject({});
      await expect(
        runFullAnalysis(indexed.fixture.dbPath, { repairVector: true }, { onProgress: () => {} }),
      ).rejects.toThrow(/incomplete analysis or embedding checkpoint/i);
      expect(mocks.initLbugForMaintenance).not.toHaveBeenCalled();
    } finally {
      await indexed.fixture.cleanup();
    }
  });

  it('repairs through a completed embedding checkpoint and clears the marker (#132)', async () => {
    const restoreEnv = pinDefaultEmbeddingIdentity();
    const indexed = await createIndexedFixture(3, {
      embeddingCheckpoint: { ...completedCheckpoint },
    });
    try {
      const { runFullAnalysis, mocks } = await importRepairSubject({});
      const result = await runFullAnalysis(
        indexed.fixture.dbPath,
        { repairVector: true },
        { onProgress: () => {} },
      );

      expect(result.vectorRepairStatus).toBe('repaired');
      expect(mocks.createVectorIndex).toHaveBeenCalledOnce();

      const repaired = JSON.parse(
        await fs.readFile(path.join(indexed.paths.storagePath, 'gitnexus.json'), 'utf8'),
      );
      expect(repaired.embeddingCheckpoint).toBeUndefined();
      expect(repaired.incrementalInProgress).toBeUndefined();
      expect(repaired.capabilities.vectorSearch.status).toBe('vector-index');
    } finally {
      restoreEnv();
      await indexed.fixture.cleanup();
    }
  });

  it('accepts the additive completed-checkpoint identity contract', async () => {
    const restoreEnv = pinDefaultEmbeddingIdentity();
    const indexed = await createIndexedFixture(3, {
      embeddingCheckpoint: {
        ...completedCheckpoint,
        physicalRows: 3,
        validRows: 3,
        recoverableIdentitySha256: 'a'.repeat(64),
        physicalRowsSha256: 'a'.repeat(64),
      },
    });
    try {
      const { runFullAnalysis } = await importRepairSubject({});
      await expect(
        runFullAnalysis(indexed.fixture.dbPath, { repairVector: true }, { onProgress: () => {} }),
      ).resolves.toMatchObject({ vectorRepairStatus: 'repaired' });
    } finally {
      restoreEnv();
      await indexed.fixture.cleanup();
    }
  });

  it('refuses same-count completed checkpoints with a different identity digest', async () => {
    const restoreEnv = pinDefaultEmbeddingIdentity();
    const indexed = await createIndexedFixture(3, {
      embeddingCheckpoint: {
        ...completedCheckpoint,
        physicalRows: 3,
        validRows: 3,
        recoverableIdentitySha256: 'b'.repeat(64),
        physicalRowsSha256: 'b'.repeat(64),
      },
    });
    try {
      const { runFullAnalysis, mocks } = await importRepairSubject({});
      await expect(
        runFullAnalysis(indexed.fixture.dbPath, { repairVector: true }, { onProgress: () => {} }),
      ).rejects.toThrow(/no longer matches the live embedding identities/i);
      expect(mocks.initLbugForMaintenance).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
      await indexed.fixture.cleanup();
    }
  });

  it('refuses a completed checkpoint whose model does not match this run', async () => {
    const restoreEnv = pinDefaultEmbeddingIdentity();
    // Model differs; dimensions match the run's resolved identity. Each field
    // must block on its own — a guard requiring BOTH to differ would let a
    // same-dimension model swap through.
    const indexed = await createIndexedFixture(3, {
      embeddingCheckpoint: { ...completedCheckpoint, model: 'voyage-code-3' },
    });
    try {
      const { runFullAnalysis, mocks } = await importRepairSubject({});
      await expect(
        runFullAnalysis(indexed.fixture.dbPath, { repairVector: true }, { onProgress: () => {} }),
      ).rejects.toThrow(/records local \/ voyage-code-3 at 384 dimensions/i);
      expect(mocks.initLbugForMaintenance).not.toHaveBeenCalled();

      const untouched = JSON.parse(
        await fs.readFile(path.join(indexed.paths.storagePath, 'gitnexus.json'), 'utf8'),
      );
      expect(untouched.embeddingCheckpoint).toMatchObject({ model: 'voyage-code-3' });
    } finally {
      restoreEnv();
      await indexed.fixture.cleanup();
    }
  });

  it('refuses a completed checkpoint whose dimensions do not match this run', async () => {
    const restoreEnv = pinDefaultEmbeddingIdentity();
    // Dimensions differ; model matches the run's resolved identity.
    const indexed = await createIndexedFixture(3, {
      embeddingCheckpoint: { ...completedCheckpoint, dimensions: 2048 },
    });
    try {
      const { runFullAnalysis, mocks } = await importRepairSubject({});
      await expect(
        runFullAnalysis(indexed.fixture.dbPath, { repairVector: true }, { onProgress: () => {} }),
      ).rejects.toThrow(/at 2048 dimensions, but this run resolves/i);
      expect(mocks.initLbugForMaintenance).not.toHaveBeenCalled();

      const untouched = JSON.parse(
        await fs.readFile(path.join(indexed.paths.storagePath, 'gitnexus.json'), 'utf8'),
      );
      expect(untouched.embeddingCheckpoint).toMatchObject({ dimensions: 2048 });
    } finally {
      restoreEnv();
      await indexed.fixture.cleanup();
    }
  });

  it('clears a completed zero-node checkpoint and resets stats on the not-indexed path', async () => {
    const restoreEnv = pinDefaultEmbeddingIdentity();
    // An empty repository's embed run completed trivially (totalNodes 0) and
    // crashed before finalize. Repair must report not-indexed AND clear the
    // checkpoint, or the repo stays permanently marked as interrupted.
    const indexed = await createIndexedFixture(5, {
      stats: { files: 2, nodes: 1, edges: 2, embeddings: 5 },
      embeddingCheckpoint: {
        ...completedCheckpoint,
        nodesProcessed: 0,
        totalNodes: 0,
        chunksProcessed: 0,
        provider: undefined,
      },
    });
    try {
      const { runFullAnalysis, mocks } = await importRepairSubject({ counts: [0, 0, 0, 0] });
      const result = await runFullAnalysis(
        indexed.fixture.dbPath,
        { repairVector: true },
        { onProgress: () => {} },
      );

      expect(result.vectorRepairStatus).toBe('not-indexed');
      expect(result.repoName).toBe('fixture-repo');
      expect(mocks.initLbugForMaintenance).not.toHaveBeenCalled();
      expect(mocks.registerRepo).toHaveBeenCalledOnce();
      expect(mocks.registerRepo.mock.calls[0]?.[1]).toMatchObject({
        stats: { nodes: 5, edges: 4, embeddings: 0 },
        embeddingCheckpoint: undefined,
        incrementalInProgress: undefined,
      });

      const cleared = JSON.parse(
        await fs.readFile(path.join(indexed.paths.storagePath, 'gitnexus.json'), 'utf8'),
      );
      expect(cleared.embeddingCheckpoint).toBeUndefined();
      expect(cleared.incrementalInProgress).toBeUndefined();
      expect(cleared.stats.embeddings).toBe(0);
      expect(cleared.stats.nodes).toBe(5);
      expect(cleared.stats.edges).toBe(4);
    } finally {
      restoreEnv();
      await indexed.fixture.cleanup();
    }
  });

  it('refuses a provider-less zero-node checkpoint that records completed chunks', async () => {
    const restoreEnv = pinDefaultEmbeddingIdentity();
    const indexed = await createIndexedFixture(0, {
      embeddingCheckpoint: {
        ...completedCheckpoint,
        nodesProcessed: 0,
        totalNodes: 0,
        chunksProcessed: 1,
        provider: undefined,
      },
    });
    try {
      const { runFullAnalysis, mocks } = await importRepairSubject({ counts: [0, 0, 0, 0] });
      await expect(
        runFullAnalysis(indexed.fixture.dbPath, { repairVector: true }, { onProgress: () => {} }),
      ).rejects.toThrow(/unknown-provider/i);
      expect(mocks.initLbugForMaintenance).not.toHaveBeenCalled();
      const untouched = JSON.parse(
        await fs.readFile(path.join(indexed.paths.storagePath, 'gitnexus.json'), 'utf8'),
      );
      expect(untouched.embeddingCheckpoint).toMatchObject({ chunksProcessed: 1 });
    } finally {
      restoreEnv();
      await indexed.fixture.cleanup();
    }
  });

  it('clears an unregistered zero-node checkpoint without first registering the index', async () => {
    const restoreEnv = pinDefaultEmbeddingIdentity();
    const indexed = await createIndexedFixture(5, {
      embeddingCheckpoint: {
        ...completedCheckpoint,
        nodesProcessed: 0,
        totalNodes: 0,
        chunksProcessed: 0,
        provider: undefined,
      },
    });
    try {
      const { runFullAnalysis, mocks } = await importRepairSubject({
        counts: [0, 0, 0, 0],
        registered: false,
      });
      const result = await runFullAnalysis(
        indexed.fixture.dbPath,
        { repairVector: true },
        { onProgress: () => {} },
      );

      expect(result.vectorRepairStatus).toBe('not-indexed');
      expect(mocks.registerRepo).not.toHaveBeenCalled();

      const cleared = JSON.parse(
        await fs.readFile(path.join(indexed.paths.storagePath, 'gitnexus.json'), 'utf8'),
      );
      expect(cleared.embeddingCheckpoint).toBeUndefined();
      expect(cleared.stats.embeddings).toBe(0);
    } finally {
      restoreEnv();
      await indexed.fixture.cleanup();
    }
  });

  it('refuses provider-less durable proof when recorded rows vanished', async () => {
    const restoreEnv = pinDefaultEmbeddingIdentity();
    const indexed = await createIndexedFixture(3, {
      embeddingCheckpoint: {
        ...completedCheckpoint,
        nodesProcessed: 0,
        totalNodes: 0,
        chunksProcessed: 0,
        provider: undefined,
        physicalRows: 3,
        validRows: 3,
        recoverableIdentitySha256: 'a'.repeat(64),
        physicalRowsSha256: 'a'.repeat(64),
      },
    });
    try {
      const { runFullAnalysis, mocks } = await importRepairSubject({ counts: [0, 0, 0, 0] });
      await expect(
        runFullAnalysis(indexed.fixture.dbPath, { repairVector: true }, { onProgress: () => {} }),
      ).rejects.toThrow(/failed embedding integrity validation/i);
      expect(mocks.initLbugForMaintenance).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
      await indexed.fixture.cleanup();
    }
  });

  it('refuses rather than returning not-indexed when ALL rows vanished after a completed checkpoint', async () => {
    const restoreEnv = pinDefaultEmbeddingIdentity();
    // The completed checkpoint recorded embedded nodes; the mocked live table
    // holds zero. Without the pre-zero-row guard this exits as a successful
    // `not-indexed`.
    const indexed = await createIndexedFixture(5, {
      embeddingCheckpoint: { ...completedCheckpoint },
    });
    try {
      const { runFullAnalysis, mocks } = await importRepairSubject({ counts: [0, 0, 0, 0] });
      await expect(
        runFullAnalysis(indexed.fixture.dbPath, { repairVector: true }, { onProgress: () => {} }),
      ).rejects.toThrow(/recorded 5 embedded nodes but the table holds no rows/i);
      expect(mocks.initLbugForMaintenance).not.toHaveBeenCalled();

      const untouched = JSON.parse(
        await fs.readFile(path.join(indexed.paths.storagePath, 'gitnexus.json'), 'utf8'),
      );
      expect(untouched.embeddingCheckpoint).toMatchObject({
        model: completedCheckpoint.model,
      });
      expect(untouched.stats.embeddings).toBe(5);
    } finally {
      restoreEnv();
      await indexed.fixture.cleanup();
    }
  });
});
