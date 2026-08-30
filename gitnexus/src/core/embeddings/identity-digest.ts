import { createHash } from 'crypto';

/** Collision-safe, reversible encoding of one semantic embedding identity. */
export const embeddingSemanticIdentity = (nodeId: string, chunkIndex: number): string =>
  JSON.stringify([nodeId, chunkIndex]);

/** Stable, order-independent digest of semantic `(nodeId, chunkIndex)` keys. */
export const embeddingIdentitySetDigest = (identities: ReadonlySet<string>): string => {
  const digest = createHash('sha256');
  digest.update('gitnexus.embedding-identities/v1\0');
  for (const identity of [...identities].sort()) {
    const encoded = Buffer.from(identity, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(encoded.length);
    digest.update(length);
    digest.update(encoded);
  }
  return digest.digest('hex');
};
export interface EmbeddingPhysicalVectorInfo {
  kind: string;
  dimensions: number;
  finite: 'finite' | 'nonfinite' | 'malformed' | 'missing';
  sha256: string;
}
export interface EmbeddingAcceptedPayload {
  id: string;
  nodeId: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  contentHash: string;
  embedding: ArrayLike<number>;
}
const token = (value: unknown): Buffer => {
  if (value === null || value === undefined) return Buffer.from(String(value));
  const text = Object.is(value, -0) ? '-0' : String(value);
  return Buffer.from(`${typeof value}:${text}`);
};
const updatePart = (digest: ReturnType<typeof createHash>, _name: string, value: unknown): void => {
  const valueBytes = token(value);
  const valueLength = Buffer.alloc(4);
  valueLength.writeUInt32BE(valueBytes.length);
  digest.update(valueLength).update(valueBytes);
};
const updateVectorValue = (digest: ReturnType<typeof createHash>, value: unknown): void => {
  if (typeof value === 'number') {
    // Persisted embedding values are FLOAT32; hash their canonical bytes.
    const bytes = Buffer.allocUnsafe(4);
    bytes.writeFloatBE(value);
    digest.update(Buffer.from([1])).update(bytes);
    return;
  }
  digest.update(Buffer.from([2]));
  const valueBytes = token(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(valueBytes.length);
  digest.update(length).update(valueBytes);
};
export const embeddingPhysicalVectorInfo = (vector: unknown): EmbeddingPhysicalVectorInfo => {
  let kind = 'missing';
  let dimensions = 0;
  let finite: any = 'missing';
  let values: ArrayLike<unknown> | undefined;
  if (Array.isArray(vector)) {
    kind = 'array';
    dimensions = vector.length;
    values = vector;
    finite = 'finite';
  } else if (ArrayBuffer.isView(vector)) {
    kind = vector.constructor?.name ?? 'typed-array';
    const length = (vector as unknown as ArrayLike<unknown>).length;
    const validLength = Number.isSafeInteger(length) && length >= 0;
    dimensions = validLength ? length : 0;
    values = validLength ? (vector as unknown as ArrayLike<unknown>) : undefined;
    finite = validLength && /^Float(?:16|32|64)Array$/.test(kind) ? 'finite' : 'malformed';
  } else if (vector !== null && vector !== undefined) {
    kind = typeof vector;
    finite = 'malformed';
  }
  const valuesDigest = createHash('sha256').update('gitnexus.embedding-vector-values/v1\0');
  if (values) {
    for (let index = 0; index < dimensions; index++) {
      const value = values[index];
      if (typeof value !== 'number') finite = 'malformed';
      else if (!Number.isFinite(value) && finite === 'finite') finite = 'nonfinite';
      updateVectorValue(valuesDigest, value);
    }
  }
  const digest = createHash('sha256').update('gitnexus.embedding-vector/v1\0');
  updatePart(digest, 'kind', kind);
  updatePart(digest, 'dimensions', dimensions);
  updatePart(digest, 'finite', finite);
  updatePart(digest, 'values-sha256', valuesDigest.digest('hex'));
  return { kind, dimensions, finite, sha256: digest.digest('hex') };
};

export const embeddingCanonicalFloat32Bytes = (vector: ArrayLike<number>): Buffer => {
  const bytes = Buffer.allocUnsafe(vector.length * 4);
  for (let index = 0; index < vector.length; index++) bytes.writeFloatBE(vector[index]!, index * 4);
  return bytes;
};

/** Stable, order-independent digest of accepted row metadata and FLOAT32 bytes. */
export const embeddingAcceptedPayloadDigest = (
  rows: Iterable<EmbeddingAcceptedPayload>,
): string => {
  const rowDigests = [...rows]
    .map((row) => {
      const digest = createHash('sha256').update('gitnexus.embedding-accepted-row/v1\0');
      for (const value of [
        row.id,
        row.nodeId,
        row.chunkIndex,
        row.startLine,
        row.endLine,
        row.contentHash,
      ])
        updatePart(digest, 'field', value);
      const bytes = embeddingCanonicalFloat32Bytes(row.embedding);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      digest.update(length).update(bytes);
      return digest.digest('hex');
    })
    .sort();
  const digest = createHash('sha256').update('gitnexus.embedding-accepted-payload/v1\0');
  updatePart(digest, 'row-count', rowDigests.length);
  for (const rowDigest of rowDigests) updatePart(digest, 'row-sha256', rowDigest);
  return digest.digest('hex');
};
export const embeddingPhysicalRowDigest = (row: Record<string, any>): string => {
  const digest = createHash('sha256').update('gitnexus.embedding-physical-row/v1\0');
  const fields = [
    row.rawId,
    row.id,
    row.rawNodeId,
    row.nodeId,
    row.rawChunkIndex,
    row.chunkIndex,
    row.rawStartLine,
    row.startLine,
    row.rawEndLine,
    row.endLine,
    row.contentHashPresent,
    row.rawContentHash,
    row.vector.kind,
    row.vector.dimensions,
    row.vector.finite,
    row.vector.sha256,
    row.ownerLabel,
    row.ownerState,
  ];
  for (const value of fields) updatePart(digest, 'field', value);
  for (const reason of [...row.rejectionReasons].sort()) updatePart(digest, 'rejection', reason);
  return digest.digest('hex');
};
export const embeddingPhysicalRowsDigest = (
  tablePresent: boolean,
  physicalRows: number,
  rowDigests: Iterable<string>,
): string => {
  const digest = createHash('sha256').update('gitnexus.embedding-physical-rows/v1\0');
  updatePart(digest, 'table-state', tablePresent ? 'present' : 'missing');
  updatePart(digest, 'physical-count', physicalRows);
  for (const rowDigest of [...rowDigests].sort()) updatePart(digest, 'row-sha256', rowDigest);
  return digest.digest('hex');
};
