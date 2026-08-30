import type { EmbeddableNode } from './types.js';
import {
  planEmbeddingPreservation,
  type PreservationEmbeddingIdentity,
  type PreservationOwnerObservation,
  type PreservationPlan,
  type PreservationPlanInput,
  type PreservationSourceIdentity,
  type PreservationStorageIdentity,
} from './preservation-plan.js';

/** The accepted rows emitted by scanEmbeddingPreservationRows.onBatch. */
export interface PreservationPreviewRow {
  id: string;
  nodeId: string;
  chunkIndex: number;
  startLine?: number;
  endLine?: number;
  embedding?: readonly number[];
  contentHash?: string;
}

/** The scanner fields needed to bind proof and owner observations. */
export interface PreservationPreviewScan {
  physicalRows: number;
  acceptedRows: number;
  rejectedRows: number;
  physicalRowsSha256: string;
  rejectedRowsSha256: string;
  acceptedPayloadSha256: string;
  implicatedOwnerIds: readonly string[];
  missingOwnerLabels?: readonly string[];
  duplicateOwnerIds?: readonly string[];
}

/** The provider-free metadata needed for one currently embeddable node. */
export interface PreservationPreviewOwner {
  nodeId: string;
  label?: string;
  chunkIndices: readonly number[];
  contentHash: string;
}

export interface PreservationPreviewBase {
  schemaVersion: string;
  plannerVersion: string;
  source: PreservationSourceIdentity;
  storage: PreservationStorageIdentity;
  embedding: PreservationEmbeddingIdentity;
}

export interface PreservationPreviewNodeDerivation {
  chunkIndicesForNode: (node: EmbeddableNode) => readonly number[] | Promise<readonly number[]>;
  contentHashForNode: (node: EmbeddableNode) => string;
}

export interface PreservationPreviewBuildInput {
  base: PreservationPreviewBase;
  scan: PreservationPreviewScan;
  acceptedRows: readonly PreservationPreviewRow[];
  owners: readonly PreservationPreviewOwner[];
}

export interface PreservationPreviewFromNodesInput extends Omit<
  PreservationPreviewBuildInput,
  'owners'
> {
  nodes: readonly EmbeddableNode[];
  derivation: PreservationPreviewNodeDerivation;
}

const sortedNumbers = (values: readonly number[]): number[] => [...values].sort((a, b) => a - b);

const assertChunkIndices = (owner: PreservationPreviewOwner): number[] => {
  const indices = sortedNumbers(owner.chunkIndices);
  if (
    indices.some(
      (index, position) =>
        !Number.isSafeInteger(index) ||
        index < 0 ||
        (position > 0 && index === indices[position - 1]),
    )
  ) {
    throw new TypeError(`Invalid or duplicate chunk index for ${owner.nodeId}`);
  }
  return indices;
};

const assertAcceptedRow = (row: PreservationPreviewRow): void => {
  if (
    !row.nodeId ||
    row.id !== `${row.nodeId}:${row.chunkIndex}` ||
    !Number.isSafeInteger(row.chunkIndex) ||
    row.chunkIndex < 0
  ) {
    throw new TypeError('Preservation scanner emitted an invalid accepted row');
  }
};

const proofForScan = (scan: PreservationPreviewScan): PreservationPlanInput['proof'] => ({
  physicalRowsSha256: scan.physicalRowsSha256,
  rejectedRowsSha256: scan.rejectedRowsSha256,
  acceptedRowsSha256: scan.acceptedPayloadSha256,
  physicalRows: scan.physicalRows,
  rejectedRows: scan.rejectedRows,
  acceptedRows: scan.acceptedRows,
});

/**
 * Derive deterministic owner observations from strict accepted rows.
 * Rejected/orphan rows stay represented by scanner proof, never by owners.
 */
export const derivePreservationOwnerObservations = ({
  scan,
  acceptedRows,
  owners,
}: Pick<
  PreservationPreviewBuildInput,
  'scan' | 'acceptedRows' | 'owners'
>): PreservationOwnerObservation[] => {
  if (
    scan.acceptedRows !== acceptedRows.length ||
    scan.physicalRows !== scan.acceptedRows + scan.rejectedRows
  ) {
    throw new Error('Preservation scanner counts are inconsistent');
  }

  const ownerMap = new Map<string, { owner: PreservationPreviewOwner; chunkIndices: number[] }>();
  for (const owner of owners) {
    if (!owner.nodeId || ownerMap.has(owner.nodeId)) {
      throw new Error('Duplicate or empty current preservation owner identity');
    }
    ownerMap.set(owner.nodeId, {
      owner,
      chunkIndices: assertChunkIndices(owner),
    });
  }

  const rowsByOwner = new Map<string, PreservationPreviewRow[]>();
  const idCounts = new Map<string, number>();
  const semanticCounts = new Map<string, number>();
  const acceptedOwnersAbsentFromEnumeration = new Set<string>();
  for (const row of acceptedRows) {
    assertAcceptedRow(row);
    idCounts.set(row.id, (idCounts.get(row.id) ?? 0) + 1);
    const semantic = `${row.nodeId}\0${row.chunkIndex}`;
    semanticCounts.set(semantic, (semanticCounts.get(semantic) ?? 0) + 1);
    if (ownerMap.has(row.nodeId)) {
      const rows = rowsByOwner.get(row.nodeId) ?? [];
      rows.push(row);
      rowsByOwner.set(row.nodeId, rows);
    } else acceptedOwnersAbsentFromEnumeration.add(row.nodeId);
  }
  if (acceptedOwnersAbsentFromEnumeration.size > 0) {
    throw new Error(
      'Preservation scanner accepted rows reference owners absent from the current owner enumeration',
    );
  }

  const implicatedOwnersAbsentFromEnumeration = scan.implicatedOwnerIds.filter(
    (ownerId) => !ownerMap.has(ownerId),
  );
  if (implicatedOwnersAbsentFromEnumeration.length > 0) {
    throw new Error(
      'Preservation scanner implicated owners absent from the current owner enumeration',
    );
  }

  const implicated = new Set(scan.implicatedOwnerIds);
  const duplicates = new Set(scan.duplicateOwnerIds ?? []);
  for (const row of acceptedRows) {
    if (
      (idCounts.get(row.id) ?? 0) > 1 ||
      (semanticCounts.get(`${row.nodeId}\0${row.chunkIndex}`) ?? 0) > 1
    ) {
      duplicates.add(row.nodeId);
      implicated.add(row.nodeId);
    }
  }
  const missingLabels = new Set(scan.missingOwnerLabels ?? []);

  return [...ownerMap.values()]
    .sort((left, right) => (left.owner.nodeId < right.owner.nodeId ? -1 : 1))
    .map(({ owner, chunkIndices }) => {
      const rows = rowsByOwner.get(owner.nodeId) ?? [];
      const expected = new Set(chunkIndices);
      const accepted = new Set<number>();
      const hashes = new Set<string>();
      let invalidChunk = false;
      let missingHash = false;
      for (const row of rows) {
        if (!expected.has(row.chunkIndex)) invalidChunk = true;
        else accepted.add(row.chunkIndex);
        if (row.contentHash === undefined || row.contentHash === '') missingHash = true;
        else hashes.add(row.contentHash);
      }
      const rejectedChunkIndices = chunkIndices.filter((index) => !accepted.has(index));
      const missingChunks = rejectedChunkIndices.length > 0;
      const observedContentHash =
        rows.length > 0 && !missingHash && hashes.size === 1 ? [...hashes][0] : null;
      const ownerImplication =
        implicated.has(owner.nodeId) ||
        duplicates.has(owner.nodeId) ||
        missingChunks ||
        invalidChunk ||
        (owner.label !== undefined && missingLabels.has(owner.label));
      return {
        ownerId: owner.nodeId,
        chunkCount: chunkIndices.length,
        acceptedChunkIndices: sortedNumbers([...accepted]),
        rejectedChunkIndices,
        expectedContentHash: owner.contentHash,
        observedContentHash,
        duplicate: duplicates.has(owner.nodeId),
        implicated: ownerImplication,
      };
    });
};

/** Build the existing pure PreservationPlan from caller-supplied proof. */
export const buildEmbeddingPreservationPreview = ({
  base,
  scan,
  acceptedRows,
  owners,
}: PreservationPreviewBuildInput): PreservationPlan =>
  planEmbeddingPreservation({
    ...base,
    proof: proofForScan(scan),
    owners: derivePreservationOwnerObservations({ scan, acceptedRows, owners }),
  });

/** Derive node chunks/hashes through injected existing pipeline functions. */
export const buildEmbeddingPreservationPreviewFromNodes = async ({
  base,
  scan,
  acceptedRows,
  nodes,
  derivation,
}: PreservationPreviewFromNodesInput): Promise<PreservationPlan> => {
  const owners = await Promise.all(
    nodes.map(async (node) => ({
      nodeId: node.id,
      label: node.label,
      chunkIndices: await derivation.chunkIndicesForNode(node),
      contentHash: derivation.contentHashForNode(node),
    })),
  );
  return buildEmbeddingPreservationPreview({
    base,
    scan,
    acceptedRows,
    owners,
  });
};
