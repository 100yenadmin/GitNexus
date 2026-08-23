import type { EmbeddingIntegrityReport } from '../lbug/lbug-adapter.js';
import type { RepoMeta } from '../../storage/repo-manager.js';

const embeddingIntegrityFailures = (report: EmbeddingIntegrityReport): number =>
  report.emptyIdRows + report.emptyNodeIdRows + report.invalidChunkRows +
  report.noncanonicalIdRows + report.duplicateIdRows + report.duplicateSemanticRows +
  report.orphanRows + report.wrongDimensionRows;

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
  'physicalRows' | 'validRows' | 'recoverableIdentitySha256'
>;

export const assertCompletedCheckpointIdentity = (
  checkpoint: CompletedEmbeddingCheckpoint,
  report: EmbeddingIntegrityReport,
  context: string,
): void => {
  const values = [
    checkpoint.physicalRows,
    checkpoint.validRows,
    checkpoint.recoverableIdentitySha256,
  ];
  if (values.every((value) => value === undefined)) return; // Legacy checkpoint.
  if (
    !Number.isSafeInteger(checkpoint.physicalRows) ||
    !Number.isSafeInteger(checkpoint.validRows) ||
    typeof checkpoint.recoverableIdentitySha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(checkpoint.recoverableIdentitySha256)
  ) {
    throw new Error(`${context} has an incomplete or malformed durable embedding identity.`);
  }
  assertEmbeddingIntegrity(report, context, checkpoint.physicalRows);
  if (
    report.validRows !== checkpoint.validRows ||
    report.recoverableIdentitySha256 !== checkpoint.recoverableIdentitySha256
  ) {
    throw new Error(
      `${context}: durable identity no longer matches the live embedding identities (${embeddingIntegritySummary(report)}).`,
    );
  }
};
