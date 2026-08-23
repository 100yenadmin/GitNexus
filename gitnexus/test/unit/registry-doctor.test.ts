import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const doctorPoolMocks = vi.hoisted(() => ({
  EXPECTED_POOL_CONNECTIONS: 8,
  probeDoctorPool: vi.fn(),
}));

vi.mock('../../src/cli/doctor-pool-probe.js', () => doctorPoolMocks);

import {
  buildRegistryDoctorReport as buildRegistryDoctorReportImpl,
  isLegacyMissingChunkIndexError,
  probeRegistryDatabaseCounts,
  type RegistryDatabaseCounts,
  type RegistryDoctorOptions,
} from '../../src/cli/registry-doctor.js';
import { getQueryEmbeddingRuntimeStatus } from '../../src/core/embeddings/runtime-support.js';
import {
  INDEX_METADATA_FILE,
  readRegistryStrict,
  type RegistryEntry,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

const buildRegistryDoctorReport = (options: RegistryDoctorOptions = {}) =>
  buildRegistryDoctorReportImpl({
    embeddingRuntimeProbe: () => ({ available: true, mode: 'local', reason: null }),
    ...options,
  });

const CAPABILITIES: NonNullable<RepoMeta['capabilities']> = {
  graph: { provider: 'ladybugdb', status: 'available' },
  fts: { provider: 'ladybugdb', status: 'available' },
  vectorSearch: {
    provider: 'ladybugdb',
    status: 'vector-index',
    exactScanLimit: 5000,
  },
};

const cleanIntegrity = (rows: number) => ({
  status: 'clean' as const,
  tablePresent: true,
  physicalRows: rows,
  validRows: rows,
  recoverableRows: rows,
  emptyIdRows: 0,
  emptyNodeIdRows: 0,
  invalidChunkRows: 0,
  noncanonicalIdRows: 0,
  duplicateIdRows: 0,
  duplicateSemanticRows: 0,
  orphanRows: 0,
  wrongDimensionRows: 0,
  recoverableIdentitySha256: 'a'.repeat(64),
  physicalRowsSha256: 'a'.repeat(64),
});

interface FixtureEntry {
  entry: RegistryEntry;
  lbugPath: string;
}

async function createEntry(
  root: string,
  directory: string,
  name: string,
  remoteUrl: string | undefined,
  counts: RegistryDatabaseCounts,
): Promise<FixtureEntry> {
  const repoPath = path.join(root, directory);
  const storagePath = path.join(repoPath, '.gitnexus');
  const lbugPath = path.join(storagePath, 'lbug');
  await fs.mkdir(storagePath, { recursive: true });
  await fs.writeFile(lbugPath, 'read-only fixture');
  const meta: RepoMeta = {
    repoPath,
    lastCommit: 'a'.repeat(40),
    indexedAt: '2026-07-20T00:00:00.000Z',
    ...(remoteUrl ? { remoteUrl } : {}),
    stats: counts,
    capabilities: CAPABILITIES,
  };
  await fs.writeFile(path.join(storagePath, INDEX_METADATA_FILE), JSON.stringify(meta));
  return {
    entry: {
      name,
      path: repoPath,
      storagePath,
      indexedAt: meta.indexedAt,
      lastCommit: meta.lastCommit,
      ...(remoteUrl ? { remoteUrl } : {}),
      stats: counts,
    },
    lbugPath,
  };
}

async function snapshotFiles(
  root: string,
): Promise<Record<string, { bytes: number; mtimeMs: number }>> {
  const snapshot: Record<string, { bytes: number; mtimeMs: number }> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const itemPath = path.join(directory, item.name);
      if (item.isDirectory()) {
        await visit(itemPath);
      } else {
        const stat = await fs.lstat(itemPath);
        snapshot[path.relative(root, itemPath)] = { bytes: stat.size, mtimeMs: stat.mtimeMs };
      }
    }
  };
  await visit(root);
  return snapshot;
}

describe('doctor --registry read-only report (#133)', () => {
  let fixture: Awaited<ReturnType<typeof createTempDir>>;

  beforeEach(async () => {
    fixture = await createTempDir();
    doctorPoolMocks.probeDoctorPool.mockReset();
    doctorPoolMocks.probeDoctorPool.mockResolvedValue({
      fts: true,
      vector: true,
      vectorIndex: true,
      vectorIndexReason: null,
      exercisedConnections: 8,
      connectionCount: 8,
      reason: null,
    });
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('rejects prefixed runtime errors as legacy chunkIndex compatibility', () => {
    expect(
      isLegacyMissingChunkIndexError(
        new Error('Runtime exception: Binder exception: Column chunkIndex does not exist'),
      ),
    ).toBe(false);
  });

  it('reports canonical remote and alias collisions, count drift, and local-only entries', async () => {
    const alpha = await createEntry(
      fixture.dbPath,
      'alpha-one',
      'Alpha',
      'git@github.com:Owner/Repo.git',
      { nodes: 10, edges: 5, embeddings: 3 },
    );
    const duplicate = await createEntry(
      fixture.dbPath,
      'alpha-two',
      'alpha',
      'https://GITHUB.com/owner/repo/',
      { nodes: 2, edges: 1, embeddings: 0 },
    );
    const local = await createEntry(fixture.dbPath, 'local-only', 'Local', undefined, {
      nodes: 0,
      edges: 0,
      embeddings: 0,
    });
    duplicate.entry.stats = { nodes: 7, edges: 1, embeddings: 0 };
    local.entry.name = local.entry.path;
    const entries = [alpha.entry, duplicate.entry, local.entry];
    const liveCounts = new Map<string, RegistryDatabaseCounts>([
      [alpha.lbugPath, { nodes: 10, edges: 5, embeddings: 3 }],
      [duplicate.lbugPath, { nodes: 99, edges: 1, embeddings: 0 }],
      [local.lbugPath, { nodes: 0, edges: 0, embeddings: 0 }],
    ]);
    const databaseProbe = vi.fn(async (lbugPath: string) => liveCounts.get(lbugPath)!);
    const before = await snapshotFiles(fixture.dbPath);

    const report = await buildRegistryDoctorReport({ entries, databaseProbe });

    expect(report.summary).toEqual({
      entries: 3,
      remoteIdentities: 2,
      localOnlyEntries: 1,
      remoteCollisionGroups: 1,
      aliasCollisionGroups: 1,
      countMismatches: 1,
      recoveryStateEntries: 0,
      lockedEntries: 0,
      unsafeStorageEntries: 0,
    });
    expect(report.collisions.remotes).toEqual([
      {
        normalizedRemote: 'github.com/owner/repo',
        canonicalEntryPosition: 1,
        entryPositions: [1, 2],
      },
    ]);
    expect(report.collisions.aliases).toEqual([{ alias: 'alpha', entryPositions: [1, 2] }]);
    expect(report.entries[1]?.countComparison).toEqual({
      status: 'mismatch',
      mismatched: ['nodes'],
      registryVsMetadata: ['nodes'],
      metadataVsDatabase: ['nodes'],
      registryVsDatabase: ['nodes'],
    });
    expect(report.entries[0]?.countComparison.status).toBe('match');
    expect(report.entries[0]?.health.state).toBe('quarantined');
    expect(report.entries[1]?.health.state).toBe('quarantined');
    expect(report.entries[0]?.health.semantic_ready).toBe(false);
    expect(report.entries[1]?.health.semantic_ready).toBe(false);
    expect(report.entries[0]?.health.reasons).toEqual(
      expect.arrayContaining(['remote-collision', 'alias-collision']),
    );
    expect(report.entries[2]?.identity).toEqual({ kind: 'local-path' });
    expect(report.entries[2]?.name).toBe('<path-like-alias>');
    expect(report.entries[0]?.capabilities.source).toBe('active-probe');
    expect(databaseProbe.mock.calls.map(([lbugPath]) => lbugPath)).toEqual([
      alpha.lbugPath,
      duplicate.lbugPath,
      local.lbugPath,
    ]);
    expect(doctorPoolMocks.probeDoctorPool.mock.calls.map(([lbugPath]) => lbugPath)).toEqual([
      alpha.lbugPath,
      duplicate.lbugPath,
      local.lbugPath,
    ]);
    expect(JSON.stringify(report)).not.toContain(fixture.dbPath);

    const withPaths = await buildRegistryDoctorReport({
      entries,
      databaseProbe,
      showPaths: true,
    });
    expect(withPaths.collisions.remotes[0]?.paths).toEqual([
      alpha.entry.path,
      duplicate.entry.path,
    ]);
    expect(withPaths.entries[0]?.path).toBe(alpha.entry.path);
    expect(JSON.stringify(withPaths)).toContain(fixture.dbPath);
    expect(await snapshotFiles(fixture.dbPath)).toEqual(before);
  });

  it('reports exact commit identities and deterministic freshness states', async () => {
    const indexed = await createEntry(
      fixture.dbPath,
      'head-states',
      'HeadStates',
      'https://github.com/owner/head-states.git',
      { nodes: 1, edges: 0, embeddings: 1 },
    );
    const databaseProbe = async () => ({
      nodes: 1,
      edges: 0,
      embeddings: 1,
      integrity: cleanIntegrity(1),
    });
    const current = await buildRegistryDoctorReport({
      entries: [indexed.entry],
      databaseProbe,
      headProbe: () => 'a'.repeat(40),
    });
    expect(current.entries[0]).toMatchObject({
      indexed_sha: 'a'.repeat(40),
      registry_sha: 'a'.repeat(40),
      head_sha: 'a'.repeat(40),
      health: { state: 'healthy', freshness: 'current', count_alignment: 'aligned' },
    });

    indexed.entry.lastCommit = 'b'.repeat(40);
    const drifted = await buildRegistryDoctorReport({
      entries: [indexed.entry],
      databaseProbe,
      headProbe: () => 'b'.repeat(40),
    });
    expect(drifted.entries[0]?.health).toMatchObject({
      state: 'degraded',
      freshness: 'drifted',
      reasons: ['freshness-drifted'],
    });

    const unknown = await buildRegistryDoctorReport({
      entries: [indexed.entry],
      databaseProbe,
      headProbe: () => '',
    });
    expect(unknown.entries[0]?.health).toMatchObject({
      state: 'degraded',
      freshness: 'unknown',
      reasons: ['freshness-unknown'],
    });
  });

  it('requires provider-free query embedding readiness for embedding-bearing entries', async () => {
    const indexed = await createEntry(
      fixture.dbPath,
      'query-runtime-missing',
      'QueryRuntimeMissing',
      'https://github.com/owner/query-runtime-missing.git',
      { nodes: 1, edges: 0, embeddings: 1 },
    );
    const report = await buildRegistryDoctorReport({
      entries: [indexed.entry],
      databaseProbe: async () => ({
        nodes: 1,
        edges: 0,
        embeddings: 1,
        integrity: cleanIntegrity(1),
      }),
      capabilityProbe: async () => ({
        fts: true,
        vector: true,
        vectorIndex: true,
        vectorIndexReason: null,
        exercisedConnections: 8,
        connectionCount: 8,
        reason: null,
      }),
      headProbe: () => 'a'.repeat(40),
      embeddingRuntimeProbe: () => ({
        available: false,
        mode: 'local',
        reason: 'local-runtime-unavailable',
      }),
    });

    expect(report.entries[0]?.health).toMatchObject({
      state: 'degraded',
      semantic_ready: false,
      reasons: ['embedding-query-local-runtime-unavailable'],
    });
  });

  it('keeps a clean HTTP endpoint available but rejects raw query and fragment markers', () => {
    const keys = [
      'GITNEXUS_EMBEDDING_URL',
      'GITNEXUS_EMBEDDING_MODEL',
      'GITNEXUS_EMBEDDING_DIMS',
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      process.env.GITNEXUS_EMBEDDING_DIMS = '384';
      for (const suffix of ['', '?', '#']) {
        process.env.GITNEXUS_EMBEDDING_URL = `https://embedding.example/v1${suffix}`;
        expect(getQueryEmbeddingRuntimeStatus()).toEqual(
          suffix === ''
            ? { available: true, mode: 'http', reason: null }
            : { available: false, mode: 'http', reason: 'http-config-invalid' },
        );
      }
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });

  it('rejects malformed registry stats values while accepting missing and zero stats', async () => {
    const previousHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = fixture.dbPath;
    const base = {
      name: 'stats-shape',
      path: path.join(fixture.dbPath, 'repo'),
      storagePath: path.join(fixture.dbPath, 'repo', '.gitnexus'),
      indexedAt: '2026-07-20T00:00:00.000Z',
      lastCommit: 'a'.repeat(40),
    };
    try {
      for (const stats of [undefined, {}, { nodes: 0, edges: 0, embeddings: 0 }]) {
        await fs.writeFile(
          path.join(fixture.dbPath, 'registry.json'),
          JSON.stringify([stats === undefined ? base : { ...base, stats }]),
        );
        expect((await readRegistryStrict()).status).toBe('available');
      }

      for (const [key, value] of [
        ['files', true],
        ['nodes', null],
        ['edges', '1'],
        ['communities', [1]],
        ['processes', -1],
        ['embeddings', Number.NaN],
      ] as const) {
        await fs.writeFile(
          path.join(fixture.dbPath, 'registry.json'),
          JSON.stringify([{ ...base, stats: { [key]: value } }]),
        );
        expect(await readRegistryStrict()).toEqual({ status: 'failed', reason: 'malformed' });
      }
    } finally {
      if (previousHome === undefined) delete process.env.GITNEXUS_HOME;
      else process.env.GITNEXUS_HOME = previousHome;
    }
  });

  it('keeps a graph-only index healthy when the embedding table is absent', async () => {
    const indexed = await createEntry(
      fixture.dbPath,
      'graph-only',
      'GraphOnly',
      'https://github.com/owner/graph-only.git',
      { nodes: 1, edges: 0, embeddings: 0 },
    );
    const report = await buildRegistryDoctorReport({
      entries: [indexed.entry],
      databaseProbe: async () => ({
        nodes: 1,
        edges: 0,
        embeddings: 0,
        integrity: { ...cleanIntegrity(0), tablePresent: false },
      }),
      headProbe: () => 'a'.repeat(40),
    });
    expect(report.entries[0]?.health).toMatchObject({
      state: 'healthy',
      semantic_ready: false,
      freshness: 'current',
      count_alignment: 'aligned',
    });
  });

  it('does not open a database when WAL recovery state is present', async () => {
    const indexed = await createEntry(
      fixture.dbPath,
      'wal-recovery',
      'WalRecovery',
      'https://github.com/owner/wal-recovery.git',
      { nodes: 1, edges: 0, embeddings: 0 },
    );
    await fs.writeFile(`${indexed.lbugPath}.wal`, 'unmatched wal');
    const databaseProbe = vi.fn(async () => ({ nodes: 1, edges: 0, embeddings: 0 }));
    const before = await snapshotFiles(fixture.dbPath);

    const report = await buildRegistryDoctorReport({
      entries: [indexed.entry],
      databaseProbe,
    });

    expect(databaseProbe).not.toHaveBeenCalled();
    expect(report.entries[0]?.sidecars.state).toBe('orphan-wal');
    expect(report.entries[0]?.database).toEqual({
      status: 'skipped',
      reason: 'recovery-state-present',
    });
    expect(report.entries[0]?.countComparison.status).toBe('partial');
    expect(report.summary.recoveryStateEntries).toBe(1);
    expect(await snapshotFiles(fixture.dbPath)).toEqual(before);
  });

  it('does not claim semantic readiness while an embedding checkpoint is present', async () => {
    const indexed = await createEntry(
      fixture.dbPath,
      'checkpoint-health',
      'CheckpointHealth',
      'https://github.com/owner/checkpoint-health.git',
      { nodes: 1, edges: 0, embeddings: 3 },
    );
    const metaPath = path.join(indexed.entry.storagePath, INDEX_METADATA_FILE);
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    const databaseProbe = async () => ({
      nodes: 1,
      edges: 0,
      embeddings: 3,
      embeddingDimensions: 384,
      integrity: cleanIntegrity(3),
    });
    for (const embeddingCheckpoint of [
      { nodesProcessed: 1, totalNodes: 3, dimensions: 384 },
      { nodesProcessed: 3, totalNodes: 3, dimensions: 384 },
    ]) {
      await fs.writeFile(metaPath, JSON.stringify({ ...meta, embeddingCheckpoint }));
      const report = await buildRegistryDoctorReport({
        entries: [indexed.entry],
        databaseProbe,
        headProbe: () => 'a'.repeat(40),
      });
      expect(report.entries[0]?.health).toMatchObject({
        state: 'degraded',
        semantic_ready: false,
        reasons: ['embedding-checkpoint-present'],
      });
    }
  });

  it('marks partial and total-loss durable checkpoints malformed', async () => {
    const indexed = await createEntry(
      fixture.dbPath,
      'checkpoint-integrity',
      'CheckpointIntegrity',
      'https://github.com/owner/checkpoint-integrity.git',
      { nodes: 1, edges: 0, embeddings: 3 },
    );
    const metaPath = path.join(indexed.entry.storagePath, INDEX_METADATA_FILE);
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    const databaseProbe = async () => ({
      nodes: 1,
      edges: 0,
      embeddings: 3,
      embeddingDimensions: 384,
      integrity: cleanIntegrity(3),
    });

    await fs.writeFile(
      metaPath,
      JSON.stringify({
        ...meta,
        embeddingCheckpoint: { dimensions: 384, physicalRows: 3 },
      }),
    );
    const partial = await buildRegistryDoctorReport({ entries: [indexed.entry], databaseProbe });
    expect(partial.entries[0]?.database).toMatchObject({
      status: 'available',
      counts: { nodes: 1, edges: 0, embeddings: 3 },
      integrity: { status: 'malformed' },
    });

    await fs.writeFile(
      metaPath,
      JSON.stringify({
        ...meta,
        embeddingCheckpoint: {
          nodesProcessed: 3,
          totalNodes: 3,
          dimensions: 384,
          physicalRows: 3,
          validRows: 3,
          recoverableIdentitySha256: 'a'.repeat(64),
          physicalRowsSha256: 'b'.repeat(64),
        },
      }),
    );
    const physicalDrift = await buildRegistryDoctorReport({
      entries: [indexed.entry],
      databaseProbe,
    });
    expect(physicalDrift.entries[0]?.database).toMatchObject({
      status: 'available',
      integrity: { status: 'malformed' },
    });

    await fs.writeFile(
      metaPath,
      JSON.stringify({
        ...meta,
        embeddingCheckpoint: {
          nodesProcessed: 2,
          totalNodes: 3,
          dimensions: 384,
          physicalRows: 3,
          validRows: 3,
          recoverableIdentitySha256: 'a'.repeat(64),
        },
      }),
    );
    const intermediate = await buildRegistryDoctorReport({
      entries: [indexed.entry],
      databaseProbe,
    });
    expect(intermediate.entries[0]?.database).toMatchObject({
      status: 'available',
      integrity: { status: 'clean' },
    });

    await fs.writeFile(
      metaPath,
      JSON.stringify({
        ...meta,
        embeddingCheckpoint: {
          nodesProcessed: 1,
          totalNodes: 1,
          dimensions: 384,
          physicalRows: 0,
          validRows: 0,
          recoverableIdentitySha256: 'a'.repeat(64),
          physicalRowsSha256: 'a'.repeat(64),
        },
      }),
    );
    const totalLoss = await buildRegistryDoctorReport({
      entries: [indexed.entry],
      databaseProbe: async () => ({
        nodes: 1,
        edges: 0,
        embeddings: 0,
        embeddingDimensions: 384,
        integrity: cleanIntegrity(0),
      }),
    });
    expect(totalLoss.entries[0]?.database).toMatchObject({
      status: 'available',
      integrity: { status: 'malformed' },
    });
  });

  it('does not open a database while a lock sidecar is present', async () => {
    const indexed = await createEntry(
      fixture.dbPath,
      'locked',
      'Locked',
      'https://github.com/owner/locked.git',
      { nodes: 1, edges: 0, embeddings: 0 },
    );
    await fs.writeFile(`${indexed.lbugPath}.lock`, 'active owner');
    const databaseProbe = vi.fn(async () => ({ nodes: 1, edges: 0, embeddings: 0 }));

    const report = await buildRegistryDoctorReport({
      entries: [indexed.entry],
      databaseProbe,
    });

    expect(databaseProbe).not.toHaveBeenCalled();
    expect(report.entries[0]?.sidecars.state).toBe('lock-present');
    expect(report.entries[0]?.database).toEqual({
      status: 'skipped',
      reason: 'database-locked',
    });
    expect(report.summary.lockedEntries).toBe(1);
    expect(report.summary.recoveryStateEntries).toBe(0);
  });

  it('keeps unsafe storage paths and capability probes out of active access', async () => {
    const indexed = await createEntry(
      fixture.dbPath,
      'unsafe',
      'Unsafe',
      'https://github.com/owner/unsafe.git',
      { nodes: 1, edges: 0, embeddings: 0 },
    );
    const unsafeEntry = {
      ...indexed.entry,
      storagePath: path.join(fixture.dbPath, 'unrelated-storage'),
    };
    const databaseProbe = vi.fn(async () => ({ nodes: 1, edges: 0, embeddings: 0 }));
    const capabilityProbe = vi.fn(async () => ({
      fts: true,
      vector: true,
      vectorIndex: true,
      vectorIndexReason: null,
      exercisedConnections: 8,
      connectionCount: 8,
      reason: null,
    }));

    const report = await buildRegistryDoctorReport({
      entries: [unsafeEntry],
      databaseProbe,
      capabilityProbe,
    });

    expect(databaseProbe).not.toHaveBeenCalled();
    expect(capabilityProbe).not.toHaveBeenCalled();
    expect(report.entries[0]?.storage.status).toBe('unsafe');
    expect(report.entries[0]?.storage).toEqual({ status: 'unsafe', reason: 'path-mismatch' });
    expect(report.entries[0]?.database).toEqual({
      status: 'skipped',
      reason: 'unsafe-storage-path',
    });
  });

  it('treats a symlinked storage directory as unsafe without reading through it', async () => {
    const indexed = await createEntry(
      fixture.dbPath,
      'symlinked',
      'Symlinked',
      'https://github.com/owner/symlinked.git',
      { nodes: 1, edges: 0, embeddings: 0 },
    );
    const realStorage = path.join(fixture.dbPath, 'real-storage');
    await fs.rename(indexed.entry.storagePath, realStorage);
    await fs.symlink(
      realStorage,
      indexed.entry.storagePath,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const databaseProbe = vi.fn(async () => ({ nodes: 1, edges: 0, embeddings: 0 }));

    const report = await buildRegistryDoctorReport({
      entries: [indexed.entry],
      databaseProbe,
    });

    expect(databaseProbe).not.toHaveBeenCalled();
    expect(report.entries[0]?.storage).toEqual({
      status: 'unsafe',
      reason: 'storage-symbolic-link',
    });
    expect(report.entries[0]?.metadata.status).toBe('not-read');
  });

  it('uses the typed capability seam only after a clean read-only database probe', async () => {
    const indexed = await createEntry(
      fixture.dbPath,
      'capability',
      'Capability',
      'https://github.com/owner/capability.git',
      { nodes: 1, edges: 0, embeddings: 1 },
    );
    const capabilityProbe = vi.fn(async () => ({
      fts: false,
      vector: true,
      vectorIndex: true,
      vectorIndexReason: null,
      exercisedConnections: 8,
      connectionCount: 8,
      reason: null,
    }));

    const report = await buildRegistryDoctorReport({
      entries: [indexed.entry],
      databaseProbe: async () => ({ nodes: 1, edges: 0, embeddings: 1 }),
      capabilityProbe,
    });

    expect(capabilityProbe).toHaveBeenCalledOnce();
    expect(capabilityProbe).toHaveBeenCalledWith(indexed.lbugPath);
    expect(report.entries[0]?.capabilities).toEqual({
      source: 'active-probe',
      graph: 'available',
      fts: 'unavailable',
      vectorSearch: 'vector-index',
      vectorSearchReason: null,
    });
  });

  it('does not claim vector-index when the live named-index probe fails', async () => {
    const indexed = await createEntry(
      fixture.dbPath,
      'missing-vector-index',
      'MissingVectorIndex',
      'https://github.com/owner/missing-vector-index.git',
      { nodes: 1, edges: 0, embeddings: 25 },
    );
    const capabilityProbe = vi.fn(async () => ({
      fts: true,
      vector: true,
      vectorIndex: false,
      vectorIndexReason: 'vector-index-missing-or-unqueryable' as const,
      exercisedConnections: 8,
      connectionCount: 8,
      reason: null,
    }));

    const report = await buildRegistryDoctorReport({
      entries: [indexed.entry],
      databaseProbe: async () => ({ nodes: 1, edges: 0, embeddings: 25 }),
      capabilityProbe,
    });

    expect(report.entries[0]?.capabilities).toEqual({
      source: 'active-probe',
      graph: 'available',
      fts: 'available',
      vectorSearch: 'unavailable',
      vectorSearchReason: 'vector-index-missing-or-unqueryable',
    });
  });

  it('reports a readable zero-embedding database as not-indexed', async () => {
    const indexed = await createEntry(
      fixture.dbPath,
      'zero-embeddings',
      'ZeroEmbeddings',
      'https://github.com/owner/zero-embeddings.git',
      { nodes: 1, edges: 0, embeddings: 0 },
    );
    const capabilityProbe = vi.fn(async () => ({
      fts: true,
      vector: true,
      vectorIndex: false,
      vectorIndexReason: 'vector-index-missing-or-unqueryable' as const,
      exercisedConnections: 8,
      connectionCount: 8,
      reason: null,
    }));

    const report = await buildRegistryDoctorReport({
      entries: [indexed.entry],
      databaseProbe: async () => ({ nodes: 1, edges: 0, embeddings: 0 }),
      capabilityProbe,
    });

    expect(report.entries[0]?.capabilities).toEqual({
      source: 'active-probe',
      graph: 'available',
      fts: 'available',
      vectorSearch: 'not-indexed',
      vectorSearchReason: null,
    });
  });

  it('lets a failed default live probe override optimistic recorded metadata', async () => {
    const indexed = await createEntry(
      fixture.dbPath,
      'live-failure',
      'LiveFailure',
      'https://github.com/owner/live-failure.git',
      { nodes: 1, edges: 0, embeddings: 1 },
    );
    doctorPoolMocks.probeDoctorPool.mockResolvedValue({
      fts: false,
      vector: false,
      vectorIndex: false,
      vectorIndexReason: 'pool-probe-unavailable',
      exercisedConnections: 0,
      connectionCount: 0,
      reason: `native load failed at ${indexed.lbugPath}`,
    });

    const report = await buildRegistryDoctorReport({
      entries: [indexed.entry],
      databaseProbe: async () => ({ nodes: 1, edges: 0, embeddings: 1 }),
    });

    expect(doctorPoolMocks.probeDoctorPool).toHaveBeenCalledWith(indexed.lbugPath);
    expect(report.entries[0]?.metadata.status).toBe('available');
    expect(report.entries[0]?.capabilities).toEqual({
      source: 'unavailable',
      graph: null,
      fts: null,
      vectorSearch: null,
      vectorSearchReason: 'pool-probe-unavailable',
    });
    expect(JSON.stringify(report)).not.toContain(indexed.lbugPath);
  });

  it('fails closed when the live probe does not exercise the complete pool', async () => {
    const indexed = await createEntry(
      fixture.dbPath,
      'partial-pool',
      'PartialPool',
      'https://github.com/owner/partial-pool.git',
      { nodes: 1, edges: 0, embeddings: 1 },
    );
    doctorPoolMocks.probeDoctorPool.mockResolvedValue({
      fts: true,
      vector: true,
      vectorIndex: true,
      vectorIndexReason: null,
      exercisedConnections: 7,
      connectionCount: 8,
      reason: null,
    });

    const report = await buildRegistryDoctorReport({
      entries: [indexed.entry],
      databaseProbe: async () => ({ nodes: 1, edges: 0, embeddings: 1 }),
    });

    expect(report.entries[0]?.capabilities.source).toBe('unavailable');
  });

  it('counts a real clean LadybugDB index through a read-only handle', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const lbugPath = path.join(fixture.dbPath, 'native-lbug');
    await adapter.initLbug(lbugPath);
    try {
      await adapter.executeQuery(
        "CREATE (f:File {id: 'file-1', name: 'fixture.ts', filePath: 'fixture.ts'})",
      );
    } finally {
      await adapter.closeLbug();
    }

    const before = await snapshotFiles(fixture.dbPath);
    await expect(probeRegistryDatabaseCounts(lbugPath)).resolves.toMatchObject({
      nodes: 1,
      edges: 0,
      embeddings: 0,
      integrity: { status: 'clean', physicalRows: 0, validRows: 0 },
    });
    expect(await snapshotFiles(fixture.dbPath)).toEqual(before);

    await adapter.initLbug(lbugPath);
    try {
      await adapter.executeQuery('DROP TABLE CodeEmbedding');
    } finally {
      await adapter.closeLbug();
    }
    await expect(probeRegistryDatabaseCounts(lbugPath)).resolves.toMatchObject({
      embeddings: 0,
      integrity: { status: 'clean', tablePresent: false, physicalRows: 0, validRows: 0 },
    });

    await fs.writeFile(`${lbugPath}.wal`, 'unmatched wal');
    await expect(probeRegistryDatabaseCounts(lbugPath)).rejects.toThrow(/sidecar state/i);
  });
});
