import { embeddingAcceptedPayloadDigest } from './identity-digest.js';
import type { PreservationPlan } from './preservation-plan.js';
import type { PreservationPreviewRow, PreservationPreviewScan } from './preservation-preview.js';

type CompleteRow = PreservationPreviewRow & {
  startLine: number;
  endLine: number;
  embedding: readonly number[];
  contentHash: string;
};

export interface PreservationApplyMutation {
  restoredRows: readonly PreservationPreviewRow[];
  restoredScan: PreservationPreviewScan;
  terminalRows: readonly PreservationPreviewRow[];
  terminalScan: PreservationPreviewScan;
  regeneratedOwners: readonly string[];
}

export interface PreservationApplyRuntime<TStage, TResult> {
  prepareStage: () => Promise<TStage>;
  mutateStage: (
    stage: TStage,
    restoreRows: readonly CompleteRow[],
    plan: PreservationPlan,
  ) => Promise<PreservationApplyMutation>;
  saveStageMetadata: (stage: TStage, plan: PreservationPlan) => Promise<void>;
  promoteStage: (stage: TStage, plan: PreservationPlan) => Promise<TResult>;
}

const completeRow = (row: PreservationPreviewRow): row is CompleteRow =>
  Number.isSafeInteger(row.startLine) &&
  Number(row.startLine) >= 0 &&
  Number.isSafeInteger(row.endLine) &&
  Number(row.endLine) >= Number(row.startLine) &&
  Array.isArray(row.embedding) &&
  typeof row.contentHash === 'string' &&
  row.contentHash.length > 0;

const rowDigest = (rows: readonly CompleteRow[]): string =>
  embeddingAcceptedPayloadDigest(
    rows.map((row) => ({
      id: row.id,
      nodeId: row.nodeId,
      chunkIndex: row.chunkIndex,
      startLine: row.startLine,
      endLine: row.endLine,
      contentHash: row.contentHash,
      embedding: row.embedding,
    })),
  );

export const selectPreservationRestoreRows = (
  plan: PreservationPlan,
  acceptedRows: readonly PreservationPreviewRow[],
): CompleteRow[] => {
  const byId = new Map(acceptedRows.map((row) => [row.id, row]));
  const selected = plan.restoreIdentities.map((identity) => byId.get(identity));
  if (selected.some((row) => row === undefined || !completeRow(row))) {
    throw new Error('The reviewed restore identity set is not available as complete accepted rows');
  }
  return selected as CompleteRow[];
};

export const assertPreservationApplyAdmission = (
  plan: PreservationPlan,
  expectedDigest: string,
  maxReembedNodes: number,
  costAdmission: 'local-zero' | 'external-price-required',
): void => {
  if (!/^[0-9a-f]{64}$/.test(expectedDigest) || plan.planDigest !== expectedDigest) {
    throw new Error('preservation plan digest does not match the reviewed plan');
  }
  if (!Number.isSafeInteger(maxReembedNodes) || maxReembedNodes <= 0) {
    throw new Error('max re-embed nodes must be a positive safe integer');
  }
  if (plan.counts.reembedOwnerCount > maxReembedNodes) {
    throw new Error('preservation plan exceeds --max-reembed-nodes');
  }
  if (costAdmission !== 'local-zero' || plan.embedding.transport !== 'onnx') {
    throw new Error('external HTTP embedding apply has no exact cost admission and is refused');
  }
};

const scanMatchesRows = (
  scan: PreservationPreviewScan,
  rows: readonly CompleteRow[],
  label: string,
): void => {
  if (
    scan.physicalRows !== rows.length ||
    scan.acceptedRows !== rows.length ||
    scan.rejectedRows !== 0 ||
    scan.acceptedPayloadSha256 !== rowDigest(rows)
  ) {
    throw new Error(`${label} failed accepted-byte preservation proof`);
  }
};

export const verifyPreservationApplyMutation = (
  plan: PreservationPlan,
  expectedRestoreRows: readonly CompleteRow[],
  mutation: PreservationApplyMutation,
): void => {
  const restored = mutation.restoredRows.filter(completeRow);
  if (restored.length !== mutation.restoredRows.length) {
    throw new Error('staged restore returned incomplete embedding rows');
  }
  scanMatchesRows(mutation.restoredScan, restored, 'staged restore');
  if (rowDigest(restored) !== rowDigest(expectedRestoreRows)) {
    throw new Error('staged restore differs from the reviewed accepted bytes');
  }

  const terminal = mutation.terminalRows.filter(completeRow);
  if (
    terminal.length !== mutation.terminalRows.length ||
    mutation.terminalScan.physicalRows !== plan.counts.expectedChunkCount ||
    mutation.terminalScan.acceptedRows !== plan.counts.expectedChunkCount ||
    mutation.terminalScan.rejectedRows !== 0 ||
    mutation.terminalScan.acceptedPayloadSha256 !== rowDigest(terminal)
  ) {
    throw new Error('terminal staged scan does not match the planned row count');
  }
  const restoredIds = new Set(plan.restoreIdentities);
  const terminalRestored = terminal.filter((row) => restoredIds.has(row.id));
  if (
    terminalRestored.length !== expectedRestoreRows.length ||
    rowDigest(terminalRestored) !== rowDigest(expectedRestoreRows)
  ) {
    throw new Error('terminal staged scan did not preserve reviewed rows byte-for-byte');
  }
  if (
    new Set(mutation.regeneratedOwners).size !== mutation.regeneratedOwners.length ||
    [...mutation.regeneratedOwners].sort().join('\0') !== [...plan.reembedOwners].sort().join('\0')
  ) {
    throw new Error('staged regeneration did not target exactly the planned owners');
  }
};

export const executePreservationApply = async <TStage, TResult>(input: {
  plan: PreservationPlan;
  acceptedRows: readonly PreservationPreviewRow[];
  expectedDigest: string;
  maxReembedNodes: number;
  costAdmission: 'local-zero' | 'external-price-required';
  runtime: PreservationApplyRuntime<TStage, TResult>;
}): Promise<TResult> => {
  assertPreservationApplyAdmission(
    input.plan,
    input.expectedDigest,
    input.maxReembedNodes,
    input.costAdmission,
  );
  const restoreRows = selectPreservationRestoreRows(input.plan, input.acceptedRows);
  const stage = await input.runtime.prepareStage();
  const mutation = await input.runtime.mutateStage(stage, restoreRows, input.plan);
  verifyPreservationApplyMutation(input.plan, restoreRows, mutation);
  await input.runtime.saveStageMetadata(stage, input.plan);
  return input.runtime.promoteStage(stage, input.plan);
};
