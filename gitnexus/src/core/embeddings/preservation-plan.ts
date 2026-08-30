import { createHash } from 'node:crypto';

export const PRESERVATION_PLAN_SCHEMA = 'gitnexus.embedding-preservation-plan/v1';
export const PRESERVATION_PLANNER_VERSION = 'm8b-planner/v1';

export interface PreservationSourceIdentity {
  head: string;
  branch: string;
  worktree: string;
}

export interface PreservationArtifactIdentity {
  canonicalPath: string;
  sha256: string;
}

export interface PreservationStorageIdentity {
  database: PreservationArtifactIdentity;
  metadata: PreservationArtifactIdentity;
}

export interface PreservationProofIdentity {
  physicalRowsSha256: string;
  rejectedRowsSha256: string;
  acceptedRowsSha256: string;
  physicalRows: number;
  rejectedRows: number;
  acceptedRows: number;
}

export interface PreservationEmbeddingIdentity {
  provider: string;
  transport: string;
  model: string;
  dimensions: number;
  textVersion: string;
}

export interface PreservationOwnerObservation {
  ownerId: string;
  chunkCount: number;
  acceptedChunkIndices: readonly number[];
  rejectedChunkIndices: readonly number[];
  expectedContentHash: string | null;
  observedContentHash: string | null;
  duplicate: boolean;
  implicated: boolean;
}

export interface PreservationPlanInput {
  schemaVersion: string;
  plannerVersion: string;
  source: PreservationSourceIdentity;
  storage: PreservationStorageIdentity;
  proof: PreservationProofIdentity;
  embedding: PreservationEmbeddingIdentity;
  owners: readonly PreservationOwnerObservation[];
}

export type PreservationReembedReason = 'duplicate' | 'implicated' | 'content-hash-mismatch';

export interface PreservationPlanCounts {
  ownerCount: number;
  expectedChunkCount: number;
  restoreOwnerCount: number;
  restoreChunkCount: number;
  reembedOwnerCount: number;
  reembedChunkCount: number;
  physicalRowCount: number;
  acceptedRowCount: number;
  rejectedRowCount: number;
}

export interface PreservationPlanDocument {
  schemaVersion: string;
  plannerVersion: string;
  source: PreservationSourceIdentity;
  storage: PreservationStorageIdentity;
  proof: PreservationProofIdentity;
  embedding: PreservationEmbeddingIdentity;
  observations: PreservationOwnerObservation[];
  restoreIdentities: string[];
  reembedOwners: string[];
  reembedReasons: Record<string, PreservationReembedReason[]>;
  counts: PreservationPlanCounts;
}

export interface PreservationPlan extends PreservationPlanDocument {
  canonicalJson: string;
  planDigest: string;
}

function assertCount(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

const assertIndices = (indices: readonly number[], name: string, chunkCount: number): void => {
  if (!Array.isArray(indices)) throw new TypeError(`${name} must be an array`);
  for (const index of indices) {
    assertCount(index, `${name} index`);
    if (index >= chunkCount) throw new RangeError(`${name} index exceeds chunkCount`);
  }
};

/** JSON with recursively sorted object keys; array order remains semantic. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('Plan contains an unsupported value');
  return encoded;
};

const ownerSort = (left: PreservationOwnerObservation, right: PreservationOwnerObservation) =>
  left.ownerId < right.ownerId ? -1 : left.ownerId > right.ownerId ? 1 : 0;

const sortedIndices = (indices: readonly number[]): number[] => [...indices].sort((a, b) => a - b);

const identitySort = (left: string, right: string): number => {
  const leftSeparator = left.lastIndexOf(':');
  const rightSeparator = right.lastIndexOf(':');
  const leftOwner = left.slice(0, leftSeparator);
  const rightOwner = right.slice(0, rightSeparator);
  if (leftOwner !== rightOwner) return leftOwner < rightOwner ? -1 : 1;
  return Number(left.slice(leftSeparator + 1)) - Number(right.slice(rightSeparator + 1));
};

const normalizeOwner = (owner: PreservationOwnerObservation): PreservationOwnerObservation => {
  if (owner.ownerId.length === 0) throw new TypeError('ownerId must not be empty');
  assertCount(owner.chunkCount, `${owner.ownerId}.chunkCount`);
  assertIndices(
    owner.acceptedChunkIndices,
    `${owner.ownerId}.acceptedChunkIndices`,
    owner.chunkCount,
  );
  assertIndices(
    owner.rejectedChunkIndices,
    `${owner.ownerId}.rejectedChunkIndices`,
    owner.chunkCount,
  );
  if (typeof owner.duplicate !== 'boolean' || typeof owner.implicated !== 'boolean') {
    throw new TypeError(`${owner.ownerId} duplicate and implicated must be boolean`);
  }
  return {
    ownerId: owner.ownerId,
    chunkCount: owner.chunkCount,
    acceptedChunkIndices: sortedIndices(owner.acceptedChunkIndices),
    rejectedChunkIndices: sortedIndices(owner.rejectedChunkIndices),
    expectedContentHash: owner.expectedContentHash ?? null,
    observedContentHash: owner.observedContentHash ?? null,
    duplicate: owner.duplicate,
    implicated: owner.implicated,
  };
};

const normalizeInput = (input: PreservationPlanInput): PreservationPlanDocument => {
  for (const key of ['physicalRows', 'rejectedRows', 'acceptedRows'] as const) {
    assertCount(input.proof[key], `proof.${key}`);
  }
  if (!Number.isSafeInteger(input.embedding.dimensions) || input.embedding.dimensions <= 0) {
    throw new TypeError('embedding.dimensions must be a positive safe integer');
  }
  if (!Array.isArray(input.owners)) throw new TypeError('owners must be an array');
  const observations = input.owners.map(normalizeOwner).sort(ownerSort);
  if (new Set(observations.map(({ ownerId }) => ownerId)).size !== observations.length) {
    throw new Error('owners must contain each ownerId once');
  }
  return {
    schemaVersion: input.schemaVersion,
    plannerVersion: input.plannerVersion,
    source: { ...input.source },
    storage: {
      database: { ...input.storage.database },
      metadata: { ...input.storage.metadata },
    },
    proof: { ...input.proof },
    embedding: { ...input.embedding },
    observations,
    restoreIdentities: [],
    reembedOwners: [],
    reembedReasons: {},
    counts: {
      ownerCount: observations.length,
      expectedChunkCount: observations.reduce((total, owner) => total + owner.chunkCount, 0),
      restoreOwnerCount: 0,
      restoreChunkCount: 0,
      reembedOwnerCount: 0,
      reembedChunkCount: 0,
      physicalRowCount: input.proof.physicalRows,
      acceptedRowCount: input.proof.acceptedRows,
      rejectedRowCount: input.proof.rejectedRows,
    },
  };
};

/**
 * Build a provider-free preservation preview. No cap is applied here: an
 * apply admission layer owns operational limits after this plan is reviewed.
 */
export const planEmbeddingPreservation = (input: PreservationPlanInput): PreservationPlan => {
  const document = normalizeInput(input);
  const restore = new Set<string>();
  const reembed = new Set<string>();
  const reasons: Record<string, PreservationReembedReason[]> = {};

  for (const owner of document.observations) {
    const contentHashMismatch =
      owner.expectedContentHash !== null && owner.expectedContentHash !== owner.observedContentHash;
    const ownerReasons: PreservationReembedReason[] = [];
    if (owner.duplicate) ownerReasons.push('duplicate');
    if (owner.implicated) ownerReasons.push('implicated');
    if (contentHashMismatch) ownerReasons.push('content-hash-mismatch');
    if (ownerReasons.length > 0) {
      reembed.add(owner.ownerId);
      reasons[owner.ownerId] = ownerReasons;
      continue;
    }
    for (const chunkIndex of owner.acceptedChunkIndices)
      restore.add(`${owner.ownerId}:${chunkIndex}`);
  }

  document.restoreIdentities = [...restore].sort(identitySort);
  document.reembedOwners = [...reembed].sort();
  document.reembedReasons = Object.fromEntries(
    document.reembedOwners.map((ownerId) => [ownerId, reasons[ownerId]]),
  );
  document.counts.restoreChunkCount = document.restoreIdentities.length;
  document.counts.restoreOwnerCount = new Set(
    document.restoreIdentities.map((identity) => identity.slice(0, identity.lastIndexOf(':'))),
  ).size;
  document.counts.reembedOwnerCount = document.reembedOwners.length;
  document.counts.reembedChunkCount = document.observations
    .filter((owner) => reembed.has(owner.ownerId))
    .reduce((total, owner) => total + owner.chunkCount, 0);

  const serialized = canonicalJson(document);
  return {
    ...document,
    canonicalJson: serialized,
    planDigest: createHash('sha256').update(serialized).digest('hex'),
  };
};
