import type { EmbeddingIntegrityReport } from '../lbug/lbug-adapter.js';
import type { RepoMeta } from '../../storage/repo-manager.js';

const embeddingIntegrityFailures = (report: EmbeddingIntegrityReport): number =>
  report.emptyIdRows +
  report.emptyNodeIdRows +
  report.invalidChunkRows +
  report.noncanonicalIdRows +
  report.duplicateIdRows +
  report.duplicateSemanticRows +
  report.orphanRows +
  report.wrongDimensionRows;

export const embeddingIntegrityIsClean = (report: EmbeddingIntegrityReport): boolean =>
  embeddingIntegrityFailures(report) === 0 && report.physicalRows === report.validRows;

export const embeddingIntegritySummary = (report: EmbeddingIntegrityReport): string =>
  `physical=${report.physicalRows}, valid=${report.validRows}, recoverable=${report.recoverableRows}, ` +
  `empty-id=${report.emptyIdRows}, empty-owner=${report.emptyNodeIdRows}, ` +
  `invalid-chunk=${report.invalidChunkRows}, noncanonical-id=${report.noncanonicalIdRows}, ` +
  `duplicate-id=${report.duplicateIdRows}, duplicate-owner-chunk=${report.duplicateSemanticRows}, ` +
  `orphan=${report.orphanRows}, wrong-dimension=${report.wrongDimensionRows}`;

export const assertEmbeddingIntegrity = (
  report: EmbeddingIntegrityReport,
  context: string,
  expectedCount?: number,
): void => {
  if (
    !embeddingIntegrityIsClean(report) ||
    (expectedCount !== undefined && report.physicalRows !== expectedCount)
  ) {
    throw new Error(
      `${context} failed embedding integrity validation (${embeddingIntegritySummary(report)}).`,
    );
  }
};

type CompletedEmbeddingCheckpoint = Pick<
  NonNullable<RepoMeta['embeddingCheckpoint']>,
  | 'nodesProcessed'
  | 'totalNodes'
  | 'physicalRows'
  | 'validRows'
  | 'recoverableIdentitySha256'
  | 'physicalRowsSha256'
>;

const isSafeNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isSha256Digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/**
 * A checkpoint with a fully persisted embedding window and durable identity.
 * These checkpoints are safe to validate and retain without treating the run
 * as interrupted or resolving the embedding runtime just to take the fast path.
 */
export const isCompletedEmbeddingCheckpoint = (value: unknown): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const checkpoint = value as Partial<NonNullable<RepoMeta['embeddingCheckpoint']>>;
  return (
    isSafeNonNegativeInteger(checkpoint.nodesProcessed) &&
    isSafeNonNegativeInteger(checkpoint.totalNodes) &&
    checkpoint.nodesProcessed === checkpoint.totalNodes &&
    isSafeNonNegativeInteger(checkpoint.chunksProcessed) &&
    Array.isArray(checkpoint.pendingNodeIds) &&
    checkpoint.pendingNodeIds.length === 0 &&
    isSafeNonNegativeInteger(checkpoint.physicalRows) &&
    isSafeNonNegativeInteger(checkpoint.validRows) &&
    checkpoint.validRows === checkpoint.physicalRows &&
    isSha256Digest(checkpoint.recoverableIdentitySha256) &&
    isSha256Digest(checkpoint.physicalRowsSha256)
  );
};

export const assertCompletedCheckpointIdentity = (
  checkpoint: CompletedEmbeddingCheckpoint,
  report: EmbeddingIntegrityReport,
  context: string,
): void => {
  const values = [
    checkpoint.physicalRows,
    checkpoint.validRows,
    checkpoint.recoverableIdentitySha256,
    checkpoint.physicalRowsSha256,
  ];
  if (values.every((value) => value === undefined)) return; // Legacy checkpoint.
  const terminalCheckpoint = checkpoint.nodesProcessed === checkpoint.totalNodes;
  if (
    !Number.isSafeInteger(checkpoint.physicalRows) ||
    !Number.isSafeInteger(checkpoint.validRows) ||
    typeof checkpoint.recoverableIdentitySha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(checkpoint.recoverableIdentitySha256) ||
    (terminalCheckpoint && checkpoint.physicalRowsSha256 === undefined) ||
    (checkpoint.physicalRowsSha256 !== undefined &&
      !/^[a-f0-9]{64}$/.test(checkpoint.physicalRowsSha256))
  ) {
    throw new Error(`${context} has an incomplete or malformed durable embedding identity.`);
  }
  assertEmbeddingIntegrity(report, context, checkpoint.physicalRows);
  if (
    report.validRows !== checkpoint.validRows ||
    report.recoverableIdentitySha256 !== checkpoint.recoverableIdentitySha256 ||
    (checkpoint.physicalRowsSha256 !== undefined &&
      report.physicalRowsSha256 !== checkpoint.physicalRowsSha256)
  ) {
    throw new Error(
      `${context}: durable identity no longer matches the live embedding identities (${embeddingIntegritySummary(report)}).`,
    );
  }
};
