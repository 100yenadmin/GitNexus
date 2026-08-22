import fs from 'node:fs/promises';
import path from 'node:path';
import { getCurrentCommit, normalizeRepositoryRemote } from '../storage/git.js';
import {
  assertSafeStoragePath,
  getStoragePaths,
  loadMeta,
  readRegistry,
  type RegistryEntry,
  type RepoMeta,
} from '../storage/repo-manager.js';
import {
  EXPECTED_POOL_CONNECTIONS,
  probeDoctorPool,
  type DoctorPoolProbe,
} from './doctor-pool-probe.js';
import type { EmbeddingIntegrityReport } from '../core/lbug/lbug-adapter.js';

export interface RegistryCounts {
  nodes: number | null;
  edges: number | null;
  embeddings: number | null;
}

export interface RegistryDatabaseCounts {
  nodes: number;
  edges: number;
  embeddings: number;
}

export type RegistryDatabaseIntegrity =
  | ({ status: 'clean' | 'malformed' } & EmbeddingIntegrityReport)
  | { status: 'malformed'; reason: 'identity-checkpoint-invalid' }
  | { status: 'unavailable'; reason: 'identity-scan-unavailable' };

export type RegistryDatabaseProbe = (lbugPath: string) => Promise<
  RegistryDatabaseCounts & {
    integrity?: RegistryDatabaseIntegrity;
    embeddingDimensions?: number;
  }
>;

export interface RegistryCapabilityReport {
  source: 'active-probe' | 'unavailable';
  graph: string | null;
  fts: string | null;
  vectorSearch: string | null;
  vectorSearchReason: DoctorPoolProbe['vectorIndexReason'];
}

export type RegistryHealthState = 'healthy' | 'degraded' | 'quarantined';
export type RegistryFreshness = 'current' | 'drifted' | 'unknown';
export type RegistryCountAlignment = 'aligned' | 'drifted' | 'unknown';

export interface RegistryHealthReport {
  state: RegistryHealthState;
  reasons: string[];
  semantic_ready: boolean;
  freshness: RegistryFreshness;
  count_alignment: RegistryCountAlignment;
}

/**
 * Typed integration seam for the production non-recovering read-pool probe.
 */
export type RegistryCapabilityProbe = (lbugPath: string) => Promise<DoctorPoolProbe>;

interface FileState {
  status: 'absent' | 'present' | 'inaccessible';
  bytes: number | null;
  regularFile: boolean;
  directory: boolean;
  symbolicLink: boolean;
}

export interface RegistrySidecarReport {
  state:
    | 'clean'
    | 'wal-with-shadow'
    | 'orphan-wal'
    | 'orphan-shadow'
    | 'checkpoint-present'
    | 'lock-present'
    | 'inaccessible'
    | 'not-inspected';
  wal: FileState;
  shadow: FileState;
  checkpoint: FileState;
  lock: FileState;
  parkedCount: number;
}

export interface RegistryEntryDoctorReport {
  entryPosition: number;
  name: string;
  path?: string;
  storagePath?: string;
  identity: { kind: 'remote'; normalizedRemote: string } | { kind: 'local-path' };
  storage:
    | { status: 'safe' }
    | {
        status: 'unsafe';
        reason:
          | 'path-mismatch'
          | 'storage-symbolic-link'
          | 'storage-not-directory'
          | 'storage-inaccessible';
      };
  registry: { counts: RegistryCounts };
  metadata: { status: 'available' | 'missing' | 'not-read'; counts: RegistryCounts };
  database:
    | {
        status: 'available';
        counts: RegistryDatabaseCounts;
        integrity: RegistryDatabaseIntegrity;
      }
    | {
        status: 'skipped' | 'unavailable';
        reason:
          | 'unsafe-storage-path'
          | 'database-missing'
          | 'database-not-regular'
          | 'recovery-state-present'
          | 'dirty-metadata'
          | 'database-locked'
          | 'read-only-open-failed';
      };
  countComparison: {
    status: 'match' | 'mismatch' | 'partial' | 'unavailable';
    mismatched: Array<keyof RegistryCounts>;
    registryVsMetadata: Array<keyof RegistryCounts>;
    metadataVsDatabase: Array<keyof RegistryCounts>;
    registryVsDatabase: Array<keyof RegistryCounts>;
  };
  sidecars: RegistrySidecarReport;
  capabilities: RegistryCapabilityReport;
  /** Exact commit identities; null means that side could not be read. */
  indexed_sha: string | null;
  registry_sha: string | null;
  head_sha: string | null;
  health: RegistryHealthReport;
}

export interface RegistryDoctorReport {
  mode: 'registry';
  readOnly: true;
  pathsShown: boolean;
  summary: {
    entries: number;
    remoteIdentities: number;
    localOnlyEntries: number;
    remoteCollisionGroups: number;
    aliasCollisionGroups: number;
    countMismatches: number;
    recoveryStateEntries: number;
    lockedEntries: number;
    unsafeStorageEntries: number;
  };
  collisions: {
    remotes: Array<{
      normalizedRemote: string;
      canonicalEntryPosition: number;
      entryPositions: number[];
      paths?: string[];
    }>;
    aliases: Array<{
      alias: string;
      entryPositions: number[];
      paths?: string[];
    }>;
  };
  entries: RegistryEntryDoctorReport[];
}

export interface RegistryDoctorOptions {
  showPaths?: boolean;
  entries?: readonly RegistryEntry[];
  databaseProbe?: RegistryDatabaseProbe;
  capabilityProbe?: RegistryCapabilityProbe;
  /** Injectable live-head seam for deterministic registry diagnostics. */
  headProbe?: (repoPath: string) => string;
}

const emptyCounts = (): RegistryCounts => ({ nodes: null, edges: null, embeddings: null });

const finiteCount = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
};

const statsCounts = (stats: RepoMeta['stats'] | undefined): RegistryCounts => ({
  nodes: finiteCount(stats?.nodes),
  edges: finiteCount(stats?.edges),
  embeddings: finiteCount(stats?.embeddings),
});

const metadataCounts = (meta: RepoMeta | null): RegistryCounts =>
  meta ? statsCounts(meta.stats) : emptyCounts();

const fileState = async (filePath: string): Promise<FileState> => {
  try {
    const stat = await fs.lstat(filePath);
    return {
      status: 'present',
      bytes: stat.size,
      regularFile: stat.isFile(),
      directory: stat.isDirectory(),
      symbolicLink: stat.isSymbolicLink(),
    };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT';
    return {
      status: missing ? 'absent' : 'inaccessible',
      bytes: null,
      regularFile: false,
      directory: false,
      symbolicLink: false,
    };
  }
};

const uninspectedSidecars = (): RegistrySidecarReport => {
  const absent: FileState = {
    status: 'absent',
    bytes: null,
    regularFile: false,
    directory: false,
    symbolicLink: false,
  };
  return {
    state: 'not-inspected',
    wal: { ...absent },
    shadow: { ...absent },
    checkpoint: { ...absent },
    lock: { ...absent },
    parkedCount: 0,
  };
};

const inspectSidecars = async (lbugPath: string): Promise<RegistrySidecarReport> => {
  const [wal, shadow, checkpoint, lock] = await Promise.all([
    fileState(`${lbugPath}.wal`),
    fileState(`${lbugPath}.shadow`),
    fileState(`${lbugPath}.wal.checkpoint`),
    fileState(`${lbugPath}.lock`),
  ]);
  let parkedCount = 0;
  try {
    const base = path.basename(lbugPath);
    parkedCount = (await fs.readdir(path.dirname(lbugPath))).filter(
      (name) =>
        name.startsWith(`${base}.wal.missing-shadow.`) ||
        name.startsWith(`${base}.wal.dirty-recovery`) ||
        name.startsWith(`${base}.shadow.dirty-recovery`),
    ).length;
  } catch {
    // The individual sidecar states already record inaccessible paths.
  }

  const inaccessible = [wal, shadow, checkpoint, lock].some(
    (item) => item.status === 'inaccessible',
  );
  const walPresent = wal.status === 'present';
  const shadowPresent = shadow.status === 'present';
  const state: RegistrySidecarReport['state'] = inaccessible
    ? 'inaccessible'
    : lock.status === 'present'
      ? 'lock-present'
      : checkpoint.status === 'present'
        ? 'checkpoint-present'
        : walPresent && shadowPresent
          ? 'wal-with-shadow'
          : walPresent
            ? 'orphan-wal'
            : shadowPresent
              ? 'orphan-shadow'
              : 'clean';
  return { state, wal, shadow, checkpoint, lock, parkedCount };
};

interface QueryResultLike {
  getAll(): Promise<Array<Record<string, unknown> | unknown[]>>;
  close(): void | Promise<void>;
}

interface QueryConnectionLike {
  query(cypher: string): Promise<QueryResultLike | QueryResultLike[]>;
}

const queryCount = async (connection: QueryConnectionLike, cypher: string): Promise<number> => {
  const raw = await connection.query(cypher);
  const results = Array.isArray(raw) ? raw : [raw];
  try {
    const rows = results[0] ? await results[0].getAll() : [];
    const first = rows[0];
    const value = Array.isArray(first) ? first[0] : first?.cnt;
    return finiteCount(value) ?? 0;
  } finally {
    await Promise.all(
      results.map(async (result) => {
        try {
          await result.close();
        } catch {
          // Closing a completed read result is best-effort; the connection is
          // still closed by the outer finally block.
        }
      }),
    );
  }
};

export const isLegacyMissingChunkIndexError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /^binder exception:\s*(?:column\s+chunkIndex\s+does not exist|cannot find property\s+chunkIndex\s+for\s+e\.?)$/i.test(
    message.trim(),
  );
};

/** Open a clean index in LadybugDB's read-only mode and issue count queries. */
export const probeRegistryDatabaseCounts: RegistryDatabaseProbe = async (lbugPath) => {
  const [adapter, lbugConfig, schema] = await Promise.all([
    import('../core/lbug/lbug-adapter.js'),
    import('../core/lbug/lbug-config.js'),
    import('../core/lbug/schema.js'),
  ]);
  await adapter.initLbugReadOnlyNonRecovering(lbugPath);
  const connection: QueryConnectionLike = {
    query: async (cypher) => ({
      getAll: async () => adapter.executeQuery(cypher),
      close: () => {},
    }),
  };
  const tableName = (name: string): string => `\`${name.replace(/`/g, '``')}\``;
  try {
    let nodes = 0;
    for (const table of schema.NODE_TABLES) {
      try {
        nodes += await queryCount(
          connection,
          `MATCH (n:${tableName(table)}) RETURN count(n) AS cnt`,
        );
      } catch (error) {
        if (lbugConfig.classifyDeleteAllError(error) !== 'benign-missing-table') throw error;
      }
    }
    let edges = 0;
    try {
      edges = await queryCount(
        connection,
        `MATCH ()-[r:${tableName(schema.REL_TABLE_NAME)}]->() RETURN count(r) AS cnt`,
      );
    } catch (error) {
      if (lbugConfig.classifyDeleteAllError(error) !== 'benign-missing-table') throw error;
    }
    let embeddings = 0;
    let embeddingTablePresent = true;
    try {
      embeddings = await queryCount(
        connection,
        `MATCH (e:${tableName(schema.EMBEDDING_TABLE_NAME)}) RETURN count(e) AS cnt`,
      );
    } catch (error) {
      if (lbugConfig.classifyDeleteAllError(error) !== 'benign-missing-table') throw error;
      embeddingTablePresent = false;
    }
    let embeddingDimensions: number | undefined;
    let report: EmbeddingIntegrityReport | undefined;
    if (embeddingTablePresent) {
      try {
        embeddingDimensions = await adapter.getStoredEmbeddingDimensions();
        report = await adapter.inspectEmbeddingIntegrity(embeddingDimensions);
      } catch (error) {
        if (!isLegacyMissingChunkIndexError(error)) throw error;
      }
    } else {
      report = await adapter.inspectEmbeddingIntegrity();
    }
    const malformed =
      report &&
      (adapter.embeddingIntegrityFailures(report) > 0 || report.physicalRows !== report.validRows);
    return {
      nodes,
      edges,
      embeddings,
      embeddingDimensions,
      integrity: report
        ? { status: malformed ? 'malformed' : 'clean', ...report }
        : { status: 'unavailable', reason: 'identity-scan-unavailable' },
    };
  } finally {
    await adapter.closeLbug();
  }
};

const unavailableCapabilities = (): RegistryCapabilityReport => ({
  source: 'unavailable',
  graph: null,
  fts: null,
  vectorSearch: null,
  vectorSearchReason: 'pool-probe-unavailable',
});

const liveCapabilities = (
  probe: DoctorPoolProbe,
  embeddingCount: number,
): RegistryCapabilityReport => {
  if (
    probe.reason ||
    probe.connectionCount !== EXPECTED_POOL_CONNECTIONS ||
    probe.exercisedConnections !== EXPECTED_POOL_CONNECTIONS
  ) {
    return unavailableCapabilities();
  }
  if (embeddingCount === 0) {
    return {
      source: 'active-probe',
      graph: 'available',
      fts: probe.fts ? 'available' : 'unavailable',
      vectorSearch: 'not-indexed',
      vectorSearchReason: null,
    };
  }
  return {
    source: 'active-probe',
    graph: 'available',
    fts: probe.fts ? 'available' : 'unavailable',
    vectorSearch: probe.vectorIndex ? 'vector-index' : 'unavailable',
    vectorSearchReason: probe.vectorIndexReason,
  };
};

const differingCounts = (
  left: RegistryCounts,
  right: RegistryCounts,
): { compared: number; mismatched: Array<keyof RegistryCounts> } => {
  const comparable = (Object.keys(left) as Array<keyof RegistryCounts>).filter(
    (key) => left[key] !== null && right[key] !== null,
  );
  return {
    compared: comparable.length,
    mismatched: comparable.filter((key) => left[key] !== right[key]),
  };
};

const compareCounts = (
  registry: RegistryCounts,
  metadata: RegistryCounts,
  database: RegistryDatabaseCounts | null,
): RegistryEntryDoctorReport['countComparison'] => {
  const databaseCounts: RegistryCounts = database ?? emptyCounts();
  const registryVsMetadata = differingCounts(registry, metadata);
  const metadataVsDatabase = differingCounts(metadata, databaseCounts);
  const registryVsDatabase = differingCounts(registry, databaseCounts);
  const mismatched = [
    ...new Set<keyof RegistryCounts>([
      ...registryVsMetadata.mismatched,
      ...metadataVsDatabase.mismatched,
      ...registryVsDatabase.mismatched,
    ]),
  ];
  const compared =
    registryVsMetadata.compared + metadataVsDatabase.compared + registryVsDatabase.compared;
  const complete =
    database !== null &&
    [...Object.values(registry), ...Object.values(metadata)].every((value) => value !== null);
  return {
    status:
      compared === 0
        ? 'unavailable'
        : mismatched.length > 0
          ? 'mismatch'
          : complete
            ? 'match'
            : 'partial',
    mismatched,
    registryVsMetadata: registryVsMetadata.mismatched,
    metadataVsDatabase: metadataVsDatabase.mismatched,
    registryVsDatabase: registryVsDatabase.mismatched,
  };
};

const nonEmptySha = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const freshnessFor = (
  indexedSha: string | null,
  registrySha: string | null,
  headSha: string | null,
): RegistryFreshness => {
  if (indexedSha === null || registrySha === null || headSha === null) return 'unknown';
  return indexedSha === registrySha && registrySha === headSha ? 'current' : 'drifted';
};

const countAlignmentFor = (
  comparison: RegistryEntryDoctorReport['countComparison'],
): RegistryCountAlignment =>
  comparison.status === 'match'
    ? 'aligned'
    : comparison.status === 'mismatch'
      ? 'drifted'
      : 'unknown';

const uniqueReasons = (reasons: string[]): string[] => [...new Set(reasons)];

const healthFor = (input: {
  reasons: string[];
  semantic_ready: boolean;
  freshness: RegistryFreshness;
  count_alignment: RegistryCountAlignment;
  quarantined?: boolean;
}): RegistryHealthReport => ({
  state: input.quarantined ? 'quarantined' : input.reasons.length > 0 ? 'degraded' : 'healthy',
  reasons: uniqueReasons(input.reasons),
  semantic_ready: input.semantic_ready,
  freshness: input.freshness,
  count_alignment: input.count_alignment,
});

const markIntegrityMalformed = (integrity: RegistryDatabaseIntegrity): RegistryDatabaseIntegrity =>
  'physicalRows' in integrity
    ? { ...integrity, status: 'malformed' }
    : { status: 'malformed', reason: 'identity-checkpoint-invalid' };

const inspectEntry = async (
  entry: RegistryEntry,
  entryPosition: number,
  options: RegistryDoctorOptions,
): Promise<RegistryEntryDoctorReport> => {
  const normalizedRemote = normalizeRepositoryRemote(entry.remoteUrl);
  const identity: RegistryEntryDoctorReport['identity'] = normalizedRemote
    ? { kind: 'remote', normalizedRemote }
    : { kind: 'local-path' };
  const base = {
    entryPosition,
    name:
      !options.showPaths && (path.isAbsolute(entry.name) || path.win32.isAbsolute(entry.name))
        ? '<path-like-alias>'
        : entry.name,
    ...(options.showPaths ? { path: entry.path, storagePath: entry.storagePath } : {}),
    identity,
    registry: { counts: statsCounts(entry.stats) },
    indexed_sha: null,
    registry_sha: nonEmptySha(entry.lastCommit),
    head_sha: null,
  };
  const unavailableComparison = compareCounts(base.registry.counts, emptyCounts(), null);

  try {
    assertSafeStoragePath(entry);
  } catch {
    return {
      ...base,
      storage: { status: 'unsafe', reason: 'path-mismatch' },
      metadata: { status: 'not-read', counts: emptyCounts() },
      database: { status: 'skipped', reason: 'unsafe-storage-path' },
      countComparison: unavailableComparison,
      sidecars: uninspectedSidecars(),
      capabilities: unavailableCapabilities(),
      health: healthFor({
        reasons: ['unsafe-storage'],
        semantic_ready: false,
        freshness: 'unknown',
        count_alignment: 'unknown',
        quarantined: true,
      }),
    };
  }

  const storageState = await fileState(entry.storagePath);
  if (
    storageState.status === 'inaccessible' ||
    (storageState.status === 'present' && (storageState.symbolicLink || !storageState.directory))
  ) {
    const reason =
      storageState.status === 'inaccessible'
        ? 'storage-inaccessible'
        : storageState.symbolicLink
          ? 'storage-symbolic-link'
          : 'storage-not-directory';
    return {
      ...base,
      storage: { status: 'unsafe', reason },
      metadata: { status: 'not-read', counts: emptyCounts() },
      database: { status: 'skipped', reason: 'unsafe-storage-path' },
      countComparison: unavailableComparison,
      sidecars: uninspectedSidecars(),
      capabilities: unavailableCapabilities(),
      health: healthFor({
        reasons: ['unsafe-storage'],
        semantic_ready: false,
        freshness: 'unknown',
        count_alignment: 'unknown',
        quarantined: true,
      }),
    };
  }

  const { lbugPath } = getStoragePaths(entry.path);
  const [meta, databaseFile, sidecars] = await Promise.all([
    loadMeta(entry.storagePath),
    fileState(lbugPath),
    inspectSidecars(lbugPath),
  ]);
  const counts = metadataCounts(meta);
  let headSha: string | null = null;
  try {
    headSha = nonEmptySha((options.headProbe ?? getCurrentCommit)(entry.path));
  } catch {
    headSha = null;
  }

  let database: RegistryEntryDoctorReport['database'];
  let availableCounts: RegistryDatabaseCounts | null = null;
  if (databaseFile.status === 'absent') {
    database = { status: 'skipped', reason: 'database-missing' };
  } else if (databaseFile.status === 'inaccessible') {
    database = { status: 'skipped', reason: 'read-only-open-failed' };
  } else if (!databaseFile.regularFile || databaseFile.symbolicLink) {
    database = { status: 'skipped', reason: 'database-not-regular' };
  } else if (meta?.incrementalInProgress) {
    database = { status: 'skipped', reason: 'dirty-metadata' };
  } else if (sidecars.lock.status === 'present') {
    database = { status: 'skipped', reason: 'database-locked' };
  } else if (sidecars.state !== 'clean') {
    database = { status: 'skipped', reason: 'recovery-state-present' };
  } else {
    try {
      const {
        integrity: scannedIntegrity,
        embeddingDimensions,
        ...scannedCounts
      } = await (options.databaseProbe ?? probeRegistryDatabaseCounts)(lbugPath);
      availableCounts = scannedCounts;
      let integrity =
        scannedIntegrity ??
        ({ status: 'unavailable', reason: 'identity-scan-unavailable' } as const);
      const checkpoint = meta?.embeddingCheckpoint;
      if (checkpoint) {
        const checkpointIdentity = [
          checkpoint.physicalRows,
          checkpoint.validRows,
          checkpoint.recoverableIdentitySha256,
        ];
        const hasCheckpointIdentity = checkpointIdentity.some((value) => value !== undefined);
        const completeCheckpointIdentity =
          Number.isSafeInteger(checkpoint.physicalRows) &&
          checkpoint.physicalRows >= 0 &&
          Number.isSafeInteger(checkpoint.validRows) &&
          checkpoint.validRows >= 0 &&
          typeof checkpoint.recoverableIdentitySha256 === 'string' &&
          /^[a-f0-9]{64}$/.test(checkpoint.recoverableIdentitySha256);
        const scannedIdentity =
          integrity.status !== 'unavailable' && 'physicalRows' in integrity ? integrity : null;
        const checkpointMismatch =
          hasCheckpointIdentity &&
          (!completeCheckpointIdentity ||
            checkpoint.physicalRows !==
              (scannedIdentity?.physicalRows ?? scannedCounts.embeddings) ||
            (scannedIdentity !== null &&
              (checkpoint.validRows !== scannedIdentity.validRows ||
                checkpoint.recoverableIdentitySha256 !==
                  scannedIdentity.recoverableIdentitySha256)));
        const dimensionMismatch =
          embeddingDimensions !== undefined && checkpoint.dimensions !== embeddingDimensions;
        const completedCheckpoint =
          checkpoint.nodesProcessed === checkpoint.totalNodes && !checkpoint.pendingNodeIds?.length;
        const totalEmbeddingLoss =
          completedCheckpoint && checkpoint.totalNodes > 0 && scannedCounts.embeddings === 0;
        if (checkpointMismatch || dimensionMismatch || totalEmbeddingLoss) {
          integrity = markIntegrityMalformed(integrity);
        }
      }
      database = { status: 'available', counts: availableCounts, integrity };
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error);
      database = {
        status: 'unavailable',
        reason:
          message.includes('lock') || message.includes('busy') || message.includes('already in use')
            ? 'database-locked'
            : 'read-only-open-failed',
      };
    }
  }

  let capabilities = unavailableCapabilities();
  if (availableCounts) {
    try {
      capabilities = liveCapabilities(
        await (options.capabilityProbe ?? probeDoctorPool)(lbugPath),
        availableCounts.embeddings,
      );
    } catch {
      capabilities = unavailableCapabilities();
    }
  }

  const countComparison = compareCounts(base.registry.counts, counts, availableCounts);
  const indexedSha = nonEmptySha(meta?.lastCommit);
  const freshness = freshnessFor(indexedSha, base.registry_sha, headSha);
  const semanticReady =
    database.status === 'available' &&
    database.counts.embeddings > 0 &&
    freshness === 'current' &&
    countAlignmentFor(countComparison) === 'aligned' &&
    database.integrity.status === 'clean' &&
    capabilities.source === 'active-probe' &&
    capabilities.graph === 'available' &&
    capabilities.fts === 'available' &&
    capabilities.vectorSearch === 'vector-index';
  const reasons: string[] = [];
  const integrity = database.status === 'available' ? database.integrity.status : 'unavailable';
  if (integrity !== 'clean') reasons.push(`embedding-identity-${integrity}`);
  if (meta?.embeddingCheckpoint !== undefined) reasons.push('embedding-checkpoint-present');
  if (freshness !== 'current') reasons.push(`freshness-${freshness}`);
  const countAlignment = countAlignmentFor(countComparison);
  if (countAlignment !== 'aligned') reasons.push(`count-alignment-${countAlignment}`);
  if (capabilities.source !== 'active-probe') reasons.push('capabilities-unavailable');
  if (capabilities.graph !== 'available') reasons.push('graph-unavailable');
  if (capabilities.fts !== 'available') reasons.push('fts-unavailable');
  const embeddings = database.status === 'available' ? database.counts.embeddings : 0;
  if (embeddings > 0 && capabilities.vectorSearch !== 'vector-index') {
    reasons.push('vector-index-unavailable');
  }

  return {
    ...base,
    storage: { status: 'safe' },
    metadata: { status: meta ? 'available' : 'missing', counts },
    database,
    countComparison,
    sidecars,
    capabilities,
    indexed_sha: indexedSha,
    head_sha: headSha,
    health: healthFor({
      reasons,
      semantic_ready: semanticReady,
      freshness,
      count_alignment: countAlignment,
      quarantined: integrity === 'malformed',
    }),
  };
};

export async function buildRegistryDoctorReport(
  options: RegistryDoctorOptions = {},
): Promise<RegistryDoctorReport> {
  const entries = options.entries ? [...options.entries] : await readRegistry();
  const indexed = entries.map((entry, index) => ({ entry, entryPosition: index + 1 }));

  const remoteGroups = new Map<string, typeof indexed>();
  const aliasGroups = new Map<string, typeof indexed>();
  for (const item of indexed) {
    const remote = normalizeRepositoryRemote(item.entry.remoteUrl);
    if (remote) remoteGroups.set(remote, [...(remoteGroups.get(remote) ?? []), item]);
    const alias = item.entry.name.toLowerCase();
    aliasGroups.set(alias, [...(aliasGroups.get(alias) ?? []), item]);
  }

  const remotes = [...remoteGroups.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([normalizedRemote, items]) => ({
      normalizedRemote,
      canonicalEntryPosition: items[0]!.entryPosition,
      entryPositions: items.map((item) => item.entryPosition),
      ...(options.showPaths ? { paths: items.map((item) => item.entry.path) } : {}),
    }));
  const aliases = [...aliasGroups.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([alias, items]) => ({
      alias:
        !options.showPaths && (path.isAbsolute(alias) || path.win32.isAbsolute(alias))
          ? '<path-like-alias>'
          : alias,
      entryPositions: items.map((item) => item.entryPosition),
      ...(options.showPaths ? { paths: items.map((item) => item.entry.path) } : {}),
    }));

  // Open at most one LadybugDB handle at a time. Registry diagnosis is an
  // operator preflight, not a throughput path, and concurrent read-only opens
  // across a large fleet would create avoidable native-runtime pressure.
  const reports: RegistryEntryDoctorReport[] = [];
  for (const { entry, entryPosition } of indexed) {
    reports.push(await inspectEntry(entry, entryPosition, options));
  }
  const remoteCollisionPositions = new Set(remotes.flatMap((collision) => collision.entryPositions));
  const aliasCollisionPositions = new Set(aliases.flatMap((collision) => collision.entryPositions));
  const healthReports = reports.map((report) => {
    const reasons = [...report.health.reasons];
    if (remoteCollisionPositions.has(report.entryPosition)) reasons.push('remote-collision');
    if (aliasCollisionPositions.has(report.entryPosition)) reasons.push('alias-collision');
    const collision =
      remoteCollisionPositions.has(report.entryPosition) ||
      aliasCollisionPositions.has(report.entryPosition);
    return {
      ...report,
      health: {
        ...report.health,
        state: collision ? ('quarantined' as const) : report.health.state,
        reasons: uniqueReasons(reasons),
      },
    };
  });
  const remoteIdentities = healthReports.filter((report) => report.identity.kind === 'remote').length;
  return {
    mode: 'registry',
    readOnly: true,
    pathsShown: options.showPaths === true,
    summary: {
      entries: healthReports.length,
      remoteIdentities,
      localOnlyEntries: healthReports.length - remoteIdentities,
      remoteCollisionGroups: remotes.length,
      aliasCollisionGroups: aliases.length,
      countMismatches: healthReports.filter((report) => report.countComparison.status === 'mismatch')
        .length,
      recoveryStateEntries: healthReports.filter(
        (report) =>
          report.sidecars.state !== 'clean' &&
          report.sidecars.state !== 'lock-present' &&
          report.sidecars.state !== 'not-inspected',
      ).length,
      lockedEntries: healthReports.filter((report) => report.sidecars.lock.status === 'present').length,
      unsafeStorageEntries: healthReports.filter((report) => report.storage.status === 'unsafe').length,
    },
    collisions: { remotes, aliases },
    entries: healthReports,
  };
}
