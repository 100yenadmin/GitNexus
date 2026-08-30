import { embeddingAcceptedPayloadDigest } from './identity-digest.js';
import type { PreservationPlan } from './preservation-plan.js';
import type { PreservationPreviewRow, PreservationPreviewScan } from './preservation-preview.js';
import { closeLbug } from '../lbug/lbug-adapter.js';

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

const deriveExpectedTerminalContentHashes = (plan: PreservationPlan): Map<string, string> => {
  const observationsByOwner = new Map(
    plan.observations.map((observation) => [observation.ownerId, observation]),
  );
  if (observationsByOwner.size !== plan.observations.length) {
    throw new Error('preservation plan contains duplicate owner observations');
  }

  const reembedOwners = new Set(plan.reembedOwners);
  if (reembedOwners.size !== plan.reembedOwners.length) {
    throw new Error('preservation plan contains duplicate re-embed owners');
  }
  for (const ownerId of reembedOwners) {
    if (!observationsByOwner.has(ownerId)) {
      throw new Error('preservation plan re-embed owner is absent from observations');
    }
  }

  const expected = new Map<string, string>();
  const expectedRestoreIdentities = new Set<string>();
  for (const observation of plan.observations) {
    if (
      typeof observation.expectedContentHash !== 'string' ||
      observation.expectedContentHash === ''
    ) {
      throw new Error('preservation plan is missing an expected terminal content hash');
    }
    if (
      !Number.isSafeInteger(observation.chunkCount) ||
      observation.chunkCount < 0 ||
      !Array.isArray(observation.acceptedChunkIndices) ||
      !Array.isArray(observation.rejectedChunkIndices)
    ) {
      throw new Error('preservation plan contains invalid terminal chunk observations');
    }
    const accepted = new Set(observation.acceptedChunkIndices);
    const rejected = new Set(observation.rejectedChunkIndices);
    const allChunks = new Set([...accepted, ...rejected]);
    if (
      accepted.size !== observation.acceptedChunkIndices.length ||
      rejected.size !== observation.rejectedChunkIndices.length ||
      allChunks.size !== observation.chunkCount ||
      [...allChunks].some(
        (chunkIndex) =>
          !Number.isSafeInteger(chunkIndex) ||
          chunkIndex < 0 ||
          chunkIndex >= observation.chunkCount,
      ) ||
      accepted.size + rejected.size !== allChunks.size
    ) {
      throw new Error('preservation plan contains incomplete terminal chunk observations');
    }
    const terminalChunks = reembedOwners.has(observation.ownerId) ? allChunks : accepted;
    for (const chunkIndex of terminalChunks) {
      const identity = `${observation.ownerId}:${chunkIndex}`;
      if (expected.has(identity)) {
        throw new Error('preservation plan contains duplicate terminal embedding identities');
      }
      expected.set(identity, observation.expectedContentHash);
    }
    if (!reembedOwners.has(observation.ownerId)) {
      for (const chunkIndex of accepted) {
        expectedRestoreIdentities.add(`${observation.ownerId}:${chunkIndex}`);
      }
    }
  }

  const restoreIdentities = new Set(plan.restoreIdentities);
  if (
    restoreIdentities.size !== plan.restoreIdentities.length ||
    restoreIdentities.size !== expectedRestoreIdentities.size ||
    [...restoreIdentities].some((identity) => !expectedRestoreIdentities.has(identity))
  ) {
    throw new Error('preservation plan restore identities do not cover terminal observations');
  }
  if (expected.size !== plan.counts.expectedChunkCount) {
    throw new Error('preservation plan terminal chunk count is inconsistent');
  }
  return expected;
};

const assertExactTerminalIdentitySet = (
  expected: ReadonlyMap<string, string>,
  terminal: readonly CompleteRow[],
): void => {
  const observed = new Set<string>();
  for (const row of terminal) {
    const canonicalIdentity = `${row.nodeId}:${row.chunkIndex}`;
    if (row.id !== canonicalIdentity || !expected.has(row.id)) {
      throw new Error('terminal staged rows do not match the planned owner/chunk set');
    }
    if (observed.has(row.id)) {
      throw new Error('terminal staged rows contain duplicate owner/chunk identities');
    }
    if (row.contentHash !== expected.get(row.id)) {
      throw new Error('terminal staged rows contain an unexpected content hash');
    }
    observed.add(row.id);
  }
  if (observed.size !== expected.size) {
    throw new Error('terminal staged rows are missing a planned owner/chunk identity');
  }
  for (const identity of expected.keys()) {
    if (!observed.has(identity)) {
      throw new Error('terminal staged rows are missing a planned owner/chunk identity');
    }
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
  const expectedTerminalContentHashes = deriveExpectedTerminalContentHashes(plan);
  assertExactTerminalIdentitySet(expectedTerminalContentHashes, terminal);
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
  let mutation: PreservationApplyMutation;
  try {
    mutation = await input.runtime.mutateStage(stage, restoreRows, input.plan);
  } finally {
    // The apply runtime opens the staged database for mutation through the
    // shared Lbug adapter. Close it before any promotion admission checks so
    // close-time CHECKPOINT and sidecar finalization can settle the stage WAL.
    await closeLbug();
  }
  verifyPreservationApplyMutation(input.plan, restoreRows, mutation);
  await input.runtime.saveStageMetadata(stage, input.plan);
  return input.runtime.promoteStage(stage, input.plan);
};
