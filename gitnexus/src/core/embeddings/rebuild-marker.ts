import fs from 'fs/promises';
import path from 'path';
import type { EmbeddingSnapshotInfo, EmbeddingSnapshotSource } from './cache-snapshot.js';

const REBUILD_MARKER_SCHEMA = 'gitnexus.embedding-table-rebuild/v1';

interface EmbeddingTableRebuildMarker {
  schema: typeof REBUILD_MARKER_SCHEMA;
  count: number;
  dimensions: number;
  identitySha256: string;
  sourceLastCommit?: string;
  sourceIndexedAt?: string;
}

const markerValue = (
  source: EmbeddingSnapshotSource,
  snapshot: EmbeddingSnapshotInfo,
): EmbeddingTableRebuildMarker => ({
  schema: REBUILD_MARKER_SCHEMA,
  count: snapshot.count,
  dimensions: snapshot.dimensions,
  identitySha256: snapshot.identitySha256,
  sourceLastCommit: source.lastCommit,
  sourceIndexedAt: source.indexedAt,
});

const markerMatches = (
  value: unknown,
  source: EmbeddingSnapshotSource,
  snapshot: EmbeddingSnapshotInfo,
): boolean => {
  if (!value || typeof value !== 'object') return false;
  const marker = value as Partial<EmbeddingTableRebuildMarker>;
  return (
    marker.schema === REBUILD_MARKER_SCHEMA &&
    marker.count === snapshot.count &&
    marker.dimensions === snapshot.dimensions &&
    marker.identitySha256 === snapshot.identitySha256 &&
    marker.sourceLastCommit === source.lastCommit &&
    marker.sourceIndexedAt === source.indexedAt
  );
};

const syncDirectory = async (directoryPath: string): Promise<void> => {
  let directory: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    directory = await fs.open(directoryPath, 'r');
    await directory.sync();
  } catch (error: any) {
    if (!['EINVAL', 'EPERM', 'EISDIR'].includes(error?.code)) throw error;
  } finally {
    await directory?.close().catch(() => {});
  }
};

/**
 * Returns false when no destructive rebuild has begun. Once a marker exists,
 * it must match the durable snapshot exactly; callers must never replace that
 * snapshot from a table that may already be empty or partially restored.
 */
export const validateEmbeddingTableRebuildMarker = async (
  markerPath: string,
  source: EmbeddingSnapshotSource,
  snapshot: EmbeddingSnapshotInfo | undefined,
): Promise<boolean> => {
  let raw: string;
  try {
    raw = await fs.readFile(markerPath, 'utf8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!snapshot) {
    throw new Error(
      'Embedding table rebuild marker exists without a valid preservation snapshot; refusing resume.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Embedding table rebuild marker is malformed; refusing resume.');
  }
  if (!markerMatches(parsed, source, snapshot)) {
    throw new Error(
      'Embedding table rebuild marker does not match the preservation snapshot; refusing resume.',
    );
  }
  return true;
};

/** Persist and fsync the snapshot identity before any destructive table work. */
export const writeEmbeddingTableRebuildMarker = async (
  markerPath: string,
  source: EmbeddingSnapshotSource,
  snapshot: EmbeddingSnapshotInfo,
): Promise<void> => {
  const tempPath = `${markerPath}.tmp-${process.pid}`;
  const handle = await fs.open(tempPath, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(markerValue(source, snapshot))}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    await fs.rename(tempPath, markerPath);
    await syncDirectory(path.dirname(markerPath));
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
};

export const removeEmbeddingTableRebuildMarker = async (markerPath: string): Promise<void> => {
  await fs.rm(markerPath, { force: true });
};
