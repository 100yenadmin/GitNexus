import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import fs from 'fs/promises';
import { createInterface } from 'readline';
import type { CachedEmbedding } from './types.js';
import { embeddingIdentitySetDigest, embeddingSemanticIdentity } from './identity-digest.js';

export const EMBEDDING_PRESERVATION_BATCH_SIZE = 256;
export const EMBEDDING_SNAPSHOT_FILE = 'embedding-preservation.jsonl';

const SNAPSHOT_SCHEMA = 'gitnexus.embedding-preservation/v1';

interface SnapshotRow {
  type: 'embedding';
  nodeId: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  embeddingBase64: string;
  contentHash?: string;
}

interface SnapshotFooter {
  type: 'complete';
  schema: typeof SNAPSHOT_SCHEMA;
  count: number;
  dimensions: number;
  sha256: string;
  sourceLastCommit?: string;
  sourceIndexedAt?: string;
}

export interface EmbeddingSnapshotSource {
  lastCommit?: string;
  indexedAt?: string;
}

export interface EmbeddingSnapshotInfo {
  count: number;
  dimensions: number;
  identitySha256: string;
  /** Repeated physical rows coalesced by (nodeId, chunkIndex). */
  duplicateRows?: number;
}

export interface EmbeddingSnapshotValidationOptions {
  /**
   * A staged checkpoint restamps metadata after the preservation snapshot is
   * written. Only that resume path may ignore the old indexedAt value; the
   * source commit, payload checksum, row count, dimensions, and identity
   * digest remain mandatory.
   */
  allowSourceIndexedAtDriftForCheckpointResume?: boolean;
}

export const embeddingSnapshotMatchesIdentityDigest = (
  info: EmbeddingSnapshotInfo,
  identitySha256: string,
): boolean => info.identitySha256 === identitySha256;

const hasValidEmbeddingIdentity = (
  row: unknown,
): row is Pick<SnapshotRow, 'nodeId' | 'chunkIndex'> => {
  if (!row || typeof row !== 'object') return false;
  const candidate = row as Record<string, unknown>;
  return (
    typeof candidate.nodeId === 'string' &&
    candidate.nodeId.length > 0 &&
    Number.isSafeInteger(candidate.chunkIndex) &&
    Number(candidate.chunkIndex) >= 0
  );
};

const embeddingIdentity = (row: Pick<SnapshotRow, 'nodeId' | 'chunkIndex'>): string =>
  embeddingSemanticIdentity(row.nodeId, row.chunkIndex);

const snapshotInfo = (
  count: number,
  dimensions: number,
  duplicateRows: number,
  identities: ReadonlySet<string>,
): EmbeddingSnapshotInfo => {
  const identitySha256 = embeddingIdentitySetDigest(identities);
  return duplicateRows > 0
    ? { count, dimensions, identitySha256, duplicateRows }
    : { count, dimensions, identitySha256 };
};

const encodeEmbedding = (embedding: number[]): string => {
  const vector = Float32Array.from(embedding);
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');
};

const decodeEmbeddingBytes = (encoded: string): Buffer => {
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new Error('Embedding preservation snapshot contains a malformed vector');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) {
    throw new Error('Embedding preservation snapshot contains a malformed vector');
  }
  return bytes;
};

const decodeEmbedding = (encoded: string, dimensions: number): number[] => {
  const bytes = decodeEmbeddingBytes(encoded);
  if (bytes.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error('Embedding preservation snapshot contains a malformed vector');
  }
  const copy = Uint8Array.from(bytes).buffer;
  return Array.from(new Float32Array(copy));
};

const toSnapshotRow = (embedding: CachedEmbedding): SnapshotRow => ({
  type: 'embedding',
  nodeId: embedding.nodeId,
  chunkIndex: embedding.chunkIndex,
  startLine: embedding.startLine,
  endLine: embedding.endLine,
  embeddingBase64: encodeEmbedding(embedding.embedding),
  contentHash: embedding.contentHash,
});

/**
 * Write an atomic, checksummed embedding snapshot without retaining more than
 * 256 vectors. The producer may stream batches through `emit`; returning a
 * small legacy array is supported for existing test doubles.
 */
export const createEmbeddingSnapshot = async (
  snapshotPath: string,
  source: EmbeddingSnapshotSource,
  producer: (
    emit: (batch: readonly CachedEmbedding[]) => Promise<void>,
  ) => Promise<readonly CachedEmbedding[] | void>,
): Promise<EmbeddingSnapshotInfo> => {
  const tempPath = `${snapshotPath}.tmp-${process.pid}`;
  const handle = await fs.open(tempPath, 'w', 0o600);
  const digest = createHash('sha256');
  let count = 0;
  let dimensions = 0;
  let duplicateRows = 0;
  // Identities are small; vectors remain bounded to the caller's 256-row batch.
  const seenIdentities = new Set<string>();

  const emit = async (batch: readonly CachedEmbedding[]): Promise<void> => {
    if (batch.length > EMBEDDING_PRESERVATION_BATCH_SIZE) {
      throw new Error(
        `Embedding preservation batch exceeds ${EMBEDDING_PRESERVATION_BATCH_SIZE} vectors`,
      );
    }
    let payload = '';
    for (const embedding of batch) {
      const rowDimensions = embedding.embedding.length;
      if (dimensions === 0) dimensions = rowDimensions;
      if (rowDimensions !== dimensions) {
        throw new Error('Embedding preservation snapshot mixes vector dimensions');
      }
      const identity = embeddingIdentity(embedding);
      if (seenIdentities.has(identity)) {
        duplicateRows++;
        continue;
      }
      seenIdentities.add(identity);
      const line = `${JSON.stringify(toSnapshotRow(embedding))}\n`;
      digest.update(line);
      payload += line;
      count++;
    }
    if (payload) await handle.writeFile(payload, 'utf8');
  };

  try {
    const legacyRows = await producer(emit);
    if (legacyRows && legacyRows.length > 0) {
      for (let i = 0; i < legacyRows.length; i += EMBEDDING_PRESERVATION_BATCH_SIZE) {
        await emit(legacyRows.slice(i, i + EMBEDDING_PRESERVATION_BATCH_SIZE));
      }
    }
    const footer: SnapshotFooter = {
      type: 'complete',
      schema: SNAPSHOT_SCHEMA,
      count,
      dimensions,
      sha256: digest.digest('hex'),
      sourceLastCommit: source.lastCommit,
      sourceIndexedAt: source.indexedAt,
    };
    await handle.writeFile(`${JSON.stringify(footer)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    await fs.rename(tempPath, snapshotPath);
    return snapshotInfo(count, dimensions, duplicateRows, seenIdentities);
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
};

/** Validate the entire snapshot before any restored row is written. */
export const validateEmbeddingSnapshot = async (
  snapshotPath: string,
  source: EmbeddingSnapshotSource,
  expectedCount?: number,
  options: EmbeddingSnapshotValidationOptions = {},
): Promise<EmbeddingSnapshotInfo | undefined> => {
  let input: ReturnType<typeof createReadStream>;
  try {
    input = createReadStream(snapshotPath, { encoding: 'utf8' });
  } catch {
    return undefined;
  }
  const lines = createInterface({ input, crlfDelay: Infinity });
  const digest = createHash('sha256');
  let physicalCount = 0;
  let uniqueCount = 0;
  let duplicateRows = 0;
  let dimensions = 0;
  let footer: SnapshotFooter | undefined;
  const seenIdentities = new Set<string>();

  try {
    for await (const line of lines) {
      if (!line) continue;
      const value = JSON.parse(line) as SnapshotRow | SnapshotFooter;
      if (value.type === 'complete') {
        if (footer) return undefined;
        footer = value;
        continue;
      }
      if (
        footer ||
        value.type !== 'embedding' ||
        !hasValidEmbeddingIdentity(value) ||
        typeof value.embeddingBase64 !== 'string'
      ) {
        return undefined;
      }
      const byteLength = decodeEmbeddingBytes(value.embeddingBase64).byteLength;
      if (byteLength === 0 || byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) return undefined;
      const rowDimensions = byteLength / Float32Array.BYTES_PER_ELEMENT;
      if (dimensions === 0) dimensions = rowDimensions;
      if (rowDimensions !== dimensions) return undefined;
      digest.update(`${line}\n`);
      physicalCount++;
      const identity = embeddingIdentity(value);
      if (seenIdentities.has(identity)) duplicateRows++;
      else {
        seenIdentities.add(identity);
        uniqueCount++;
      }
    }
  } catch {
    return undefined;
  } finally {
    lines.close();
    input.destroy();
  }

  if (
    !footer ||
    footer.schema !== SNAPSHOT_SCHEMA ||
    footer.count !== physicalCount ||
    footer.dimensions !== dimensions ||
    footer.sha256 !== digest.digest('hex') ||
    footer.sourceLastCommit !== source.lastCommit ||
    (!options.allowSourceIndexedAtDriftForCheckpointResume &&
      footer.sourceIndexedAt !== source.indexedAt) ||
    (expectedCount !== undefined && uniqueCount !== expectedCount)
  ) {
    return undefined;
  }
  return snapshotInfo(uniqueCount, dimensions, duplicateRows, seenIdentities);
};

/**
 * Read a previously validated snapshot in vector batches bounded to 256.
 * Validation is repeated first so a corrupt file can never be partially restored.
 */
export const readEmbeddingSnapshot = async (
  snapshotPath: string,
  source: EmbeddingSnapshotSource,
  onBatch: (batch: readonly CachedEmbedding[]) => Promise<void>,
  expectedCount?: number,
  options: EmbeddingSnapshotValidationOptions = {},
): Promise<EmbeddingSnapshotInfo> => {
  const info = await validateEmbeddingSnapshot(snapshotPath, source, expectedCount, options);
  if (!info) throw new Error('Embedding preservation snapshot failed validation');

  const input = createReadStream(snapshotPath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let batch: CachedEmbedding[] = [];
  const seenIdentities = new Set<string>();
  try {
    for await (const line of lines) {
      if (!line) continue;
      const value = JSON.parse(line) as SnapshotRow | SnapshotFooter;
      if (value.type === 'complete') break;
      if (!hasValidEmbeddingIdentity(value)) {
        throw new Error('Embedding preservation snapshot failed validation');
      }
      const identity = embeddingIdentity(value);
      if (seenIdentities.has(identity)) continue;
      seenIdentities.add(identity);
      batch.push({
        nodeId: value.nodeId,
        chunkIndex: value.chunkIndex,
        startLine: value.startLine,
        endLine: value.endLine,
        embedding: decodeEmbedding(value.embeddingBase64, info.dimensions),
        contentHash: value.contentHash,
      });
      if (batch.length === EMBEDDING_PRESERVATION_BATCH_SIZE) {
        await onBatch(batch);
        batch = [];
      }
    }
    if (batch.length > 0) await onBatch(batch);
  } finally {
    lines.close();
    input.destroy();
  }
  return info;
};

export const removeEmbeddingSnapshot = async (snapshotPath: string): Promise<void> => {
  await fs.rm(snapshotPath, { force: true });
};
