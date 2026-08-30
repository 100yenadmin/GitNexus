import { describe, expect, it, vi } from 'vitest';
import { preservationApplyCommand } from '../../src/cli/preservation-apply-cli.js';
import * as lbugAdapter from '../../src/core/lbug/lbug-adapter.js';
import { embeddingAcceptedPayloadDigest } from '../../src/core/embeddings/identity-digest.js';
import {
  executePreservationApply,
  verifyPreservationApplyMutation,
  type PreservationApplyMutation,
} from '../../src/core/embeddings/preservation-apply.js';
import { buildEmbeddingPreservationPreview } from '../../src/core/embeddings/preservation-preview.js';
import {
  PRESERVATION_PLAN_SCHEMA,
  PRESERVATION_PLANNER_VERSION,
} from '../../src/core/embeddings/preservation-plan.js';

const keepRow = {
  id: 'Function:keep:0',
  nodeId: 'Function:keep',
  chunkIndex: 0,
  startLine: 1,
  endLine: 2,
  contentHash: 'keep-hash',
  embedding: [0.25, -0.5],
};

const regeneratedRow = {
  id: 'Function:regen:0',
  nodeId: 'Function:regen',
  chunkIndex: 0,
  startLine: 3,
  endLine: 4,
  contentHash: 'new-hash',
  embedding: [0.75, 1],
};

const secondRegeneratedRow = {
  ...regeneratedRow,
  id: 'Function:regen-two:0',
  nodeId: 'Function:regen-two',
  startLine: 5,
  endLine: 6,
  contentHash: 'second-hash',
};

const digest = (rows: readonly (typeof keepRow)[]) => embeddingAcceptedPayloadDigest(rows);

const scan = (rows: readonly (typeof keepRow)[]) => ({
  physicalRows: rows.length,
  acceptedRows: rows.length,
  rejectedRows: 0,
  physicalRowsSha256: `physical-${rows.length}`,
  rejectedRowsSha256: 'rejected-0',
  acceptedPayloadSha256: digest(rows),
  implicatedOwnerIds: [],
});

const plan = buildEmbeddingPreservationPreview({
  base: {
    schemaVersion: PRESERVATION_PLAN_SCHEMA,
    plannerVersion: PRESERVATION_PLANNER_VERSION,
    source: { head: 'head-a', branch: 'main', worktree: '/repo' },
    storage: {
      database: { canonicalPath: '/repo/.gitnexus/lbug', sha256: 'db-a' },
      metadata: { canonicalPath: '/repo/.gitnexus/gitnexus.json', sha256: 'meta-a' },
    },
    embedding: {
      provider: 'local',
      transport: 'onnx',
      model: 'model-a',
      dimensions: 2,
      textVersion: 'v4',
    },
  },
  scan: {
    ...scan([keepRow]),
    physicalRows: 1,
    acceptedRows: 1,
  },
  acceptedRows: [keepRow],
  owners: [
    {
      nodeId: keepRow.nodeId,
      label: 'Function',
      chunkIndices: [0],
      contentHash: keepRow.contentHash,
    },
    {
      nodeId: regeneratedRow.nodeId,
      label: 'Function',
      chunkIndices: [0],
      contentHash: regeneratedRow.contentHash,
    },
    {
      nodeId: secondRegeneratedRow.nodeId,
      label: 'Function',
      chunkIndices: [0],
      contentHash: secondRegeneratedRow.contentHash,
    },
  ],
});

const mutation = (
  overrides: Partial<PreservationApplyMutation> = {},
): PreservationApplyMutation => ({
  restoredRows: [keepRow],
  restoredScan: scan([keepRow]),
  terminalRows: [keepRow, regeneratedRow, secondRegeneratedRow],
  terminalScan: scan([keepRow, regeneratedRow, secondRegeneratedRow]),
  regeneratedOwners: [regeneratedRow.nodeId, secondRegeneratedRow.nodeId],
  ...overrides,
});

const runtime = (events: string[], result: PreservationApplyMutation = mutation()) => ({
  prepareStage: vi.fn(async () => {
    events.push('prepare');
    return 'stage';
  }),
  mutateStage: vi.fn(async () => {
    events.push('mutate');
    return result;
  }),
  saveStageMetadata: vi.fn(async () => {
    events.push('metadata');
  }),
  promoteStage: vi.fn(async () => {
    events.push('promote');
    return 'promoted';
  }),
});

describe('preservation apply admission and orchestration', () => {
  it('refuses invalid CLI admission before repository or provider setup', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const previousExitCode = process.exitCode;
    const previousOrt = process.env.ORT_LOG_LEVEL;
    process.env.ORT_LOG_LEVEL = '4';
    await preservationApplyCommand('/definitely/not/a/repository', {
      preserveVerifiedEmbeddings: true,
      staged: true,
      embeddings: true,
      planDigest: 'invalid',
      maxReembedNodes: '1',
    });
    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('64-hex'));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(process.env.ORT_LOG_LEVEL).toBe('4');
    process.exitCode = previousExitCode;
    if (previousOrt === undefined) delete process.env.ORT_LOG_LEVEL;
    else process.env.ORT_LOG_LEVEL = previousOrt;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['wrong digest', '0'.repeat(64), 1, 'local-zero' as const],
    ['invalid cap', plan.planDigest, 0, 'local-zero' as const],
    ['too-low cap', plan.planDigest, 1, 'local-zero' as const],
    ['external cost', plan.planDigest, 2, 'external-price-required' as const],
  ])('refuses %s before runtime callbacks', async (_label, expectedDigest, cap, costAdmission) => {
    const events: string[] = [];
    const callbacks = runtime(events);
    await expect(
      executePreservationApply({
        plan,
        acceptedRows: [keepRow],
        expectedDigest,
        maxReembedNodes: cap,
        costAdmission,
        runtime: callbacks,
      }),
    ).rejects.toThrow();
    expect(events).toEqual([]);
  });

  it('refuses an unavailable restore row before staging', async () => {
    const events: string[] = [];
    await expect(
      executePreservationApply({
        plan,
        acceptedRows: [],
        expectedDigest: plan.planDigest,
        maxReembedNodes: 2,
        costAdmission: 'local-zero',
        runtime: runtime(events),
      }),
    ).rejects.toThrow('restore identity set');
    expect(events).toEqual([]);
  });

  it('rejects changed preserved bytes and never saves metadata or promotes', async () => {
    const events: string[] = [];
    const changed = { ...keepRow, embedding: [0.5, -0.5] };
    const callbacks = runtime(
      events,
      mutation({ restoredRows: [changed], restoredScan: scan([changed]) }),
    );
    await expect(
      executePreservationApply({
        plan,
        acceptedRows: [keepRow],
        expectedDigest: plan.planDigest,
        maxReembedNodes: 2,
        costAdmission: 'local-zero',
        runtime: callbacks,
      }),
    ).rejects.toThrow('reviewed accepted bytes');
    expect(events).toEqual(['prepare', 'mutate']);
    expect(callbacks.saveStageMetadata).not.toHaveBeenCalled();
    expect(callbacks.promoteStage).not.toHaveBeenCalled();
  });

  it('rejects regeneration outside the planned owner set', () => {
    expect(() =>
      verifyPreservationApplyMutation(
        plan,
        [keepRow],
        mutation({ regeneratedOwners: ['Function:other'] }),
      ),
    ).toThrow('exactly the planned owners');
  });

  it('prepares only after admission and promotes only after byte/readback proof', async () => {
    const events: string[] = [];
    const callbacks = runtime(events);
    await expect(
      executePreservationApply({
        plan,
        acceptedRows: [keepRow],
        expectedDigest: plan.planDigest,
        maxReembedNodes: 2,
        costAdmission: 'local-zero',
        runtime: callbacks,
      }),
    ).resolves.toBe('promoted');
    expect(events).toEqual(['prepare', 'mutate', 'metadata', 'promote']);
  });

  it('closes the staged connection before promotion admission can observe its WAL', async () => {
    const events: string[] = [];
    let stagedWalPresent = false;
    const closeLbug = vi.spyOn(lbugAdapter, 'closeLbug').mockImplementation(async () => {
      events.push('close');
      stagedWalPresent = false;
    });
    const callbacks = {
      prepareStage: vi.fn(async () => {
        events.push('prepare');
        return 'stage';
      }),
      mutateStage: vi.fn(async () => {
        events.push('mutate');
        stagedWalPresent = true;
        return mutation();
      }),
      saveStageMetadata: vi.fn(async () => {
        events.push('metadata');
      }),
      promoteStage: vi.fn(async () => {
        expect(stagedWalPresent).toBe(false);
        events.push('promote');
        return 'promoted';
      }),
    };

    try {
      await expect(
        executePreservationApply({
          plan,
          acceptedRows: [keepRow],
          expectedDigest: plan.planDigest,
          maxReembedNodes: 2,
          costAdmission: 'local-zero',
          runtime: callbacks,
        }),
      ).resolves.toBe('promoted');
      expect(closeLbug).toHaveBeenCalledOnce();
    } finally {
      closeLbug.mockRestore();
    }

    expect(events).toEqual(['prepare', 'mutate', 'close', 'metadata', 'promote']);
  });
});
