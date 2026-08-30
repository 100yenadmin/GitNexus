import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  planEmbeddingPreservation,
  PRESERVATION_PLAN_SCHEMA,
  PRESERVATION_PLANNER_VERSION,
  type PreservationPlanInput,
} from '../../src/core/embeddings/preservation-plan.js';

const owner = (ownerId: string, overrides = {}) => ({
  ownerId,
  chunkCount: 3,
  acceptedChunkIndices: [0, 1, 2],
  rejectedChunkIndices: [],
  expectedContentHash: 'source-hash',
  observedContentHash: 'source-hash',
  duplicate: false,
  implicated: false,
  ...overrides,
});

const input = (): PreservationPlanInput => ({
  schemaVersion: PRESERVATION_PLAN_SCHEMA,
  plannerVersion: PRESERVATION_PLANNER_VERSION,
  source: { head: 'head-a', branch: 'main', worktree: '/repo/worktree' },
  storage: {
    database: { canonicalPath: '/repo/.gitnexus/lbug', sha256: 'db-a' },
    metadata: { canonicalPath: '/repo/.gitnexus/gitnexus.json', sha256: 'meta-a' },
  },
  proof: {
    physicalRowsSha256: 'physical-a',
    rejectedRowsSha256: 'rejected-a',
    acceptedRowsSha256: 'accepted-a',
    physicalRows: 9,
    rejectedRows: 0,
    acceptedRows: 9,
  },
  embedding: {
    provider: 'local',
    transport: 'onnx',
    model: 'model-a',
    dimensions: 384,
    textVersion: 'text-a',
  },
  owners: [owner('Function:a'), owner('Function:b')],
});

describe('provider-free embedding preservation planner', () => {
  it('is order-independent and expands duplicate/implicated owners', () => {
    const planned = planEmbeddingPreservation({
      ...input(),
      owners: [
        owner('Function:z', { duplicate: true, acceptedChunkIndices: [2, 0] }),
        owner('Function:a', { implicated: true }),
        owner('Function:m'),
      ],
    });
    const reordered = planEmbeddingPreservation({
      ...input(),
      owners: [...input().owners].reverse(),
    });
    expect(planned.reembedOwners).toEqual(['Function:a', 'Function:z']);
    expect(planned.restoreIdentities).toEqual(['Function:m:0', 'Function:m:1', 'Function:m:2']);
    expect(planned.counts).toMatchObject({
      ownerCount: 3,
      expectedChunkCount: 9,
      reembedOwnerCount: 2,
      reembedChunkCount: 6,
      restoreOwnerCount: 1,
      restoreChunkCount: 3,
    });
    expect(reordered.planDigest).toBe(planEmbeddingPreservation(input()).planDigest);
  });

  it('re-embeds a whole owner on content-hash mismatch, including a missing hash', () => {
    const planned = planEmbeddingPreservation({
      ...input(),
      owners: [
        owner('Function:match'),
        owner('Function:stale', { observedContentHash: 'old-hash' }),
        owner('Function:missing', { observedContentHash: null }),
      ],
    });
    expect(planned.reembedOwners).toEqual(['Function:missing', 'Function:stale']);
    expect(planned.restoreIdentities).toEqual([
      'Function:match:0',
      'Function:match:1',
      'Function:match:2',
    ]);
    expect(planned.reembedReasons['Function:stale']).toEqual(['content-hash-mismatch']);
  });

  it('has stable canonical JSON, digest exclusion, and no input/env mutation', () => {
    const value = input();
    const before = structuredClone(value);
    const previous = process.env.GITNEXUS_EMBEDDING_MODEL;
    const planned = planEmbeddingPreservation(value);
    expect(value).toEqual(before);
    expect(process.env.GITNEXUS_EMBEDDING_MODEL).toBe(previous);
    expect(planned.canonicalJson).toBe(canonicalJson(JSON.parse(planned.canonicalJson)));
    expect(JSON.parse(planned.canonicalJson)).not.toHaveProperty('planDigest');
    expect(planned.planDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(planned.counts.reembedOwnerCount).toBe(0);
  });

  it.each([
    ['schemaVersion', (v: PreservationPlanInput) => (v.schemaVersion = 'other-schema')],
    ['plannerVersion', (v: PreservationPlanInput) => (v.plannerVersion = 'other-planner')],
    ['source.head', (v: PreservationPlanInput) => (v.source.head = 'head-b')],
    ['source.branch', (v: PreservationPlanInput) => (v.source.branch = 'branch-b')],
    ['source.worktree', (v: PreservationPlanInput) => (v.source.worktree = '/other')],
    ['database path', (v: PreservationPlanInput) => (v.storage.database.canonicalPath = '/db-b')],
    ['database digest', (v: PreservationPlanInput) => (v.storage.database.sha256 = 'db-b')],
    ['metadata path', (v: PreservationPlanInput) => (v.storage.metadata.canonicalPath = '/meta-b')],
    ['metadata digest', (v: PreservationPlanInput) => (v.storage.metadata.sha256 = 'meta-b')],
    ['physical proof', (v: PreservationPlanInput) => (v.proof.physicalRowsSha256 = 'p-b')],
    ['rejected proof', (v: PreservationPlanInput) => (v.proof.rejectedRowsSha256 = 'r-b')],
    ['accepted proof', (v: PreservationPlanInput) => (v.proof.acceptedRowsSha256 = 'a-b')],
    ['physical count', (v: PreservationPlanInput) => (v.proof.physicalRows = 10)],
    ['rejected count', (v: PreservationPlanInput) => (v.proof.rejectedRows = 1)],
    ['accepted count', (v: PreservationPlanInput) => (v.proof.acceptedRows = 8)],
    ['provider', (v: PreservationPlanInput) => (v.embedding.provider = 'remote')],
    ['transport', (v: PreservationPlanInput) => (v.embedding.transport = 'http')],
    ['model', (v: PreservationPlanInput) => (v.embedding.model = 'model-b')],
    ['dimensions', (v: PreservationPlanInput) => (v.embedding.dimensions = 768)],
    ['text version', (v: PreservationPlanInput) => (v.embedding.textVersion = 'text-b')],
    ['owner id', (v: PreservationPlanInput) => (v.owners[0].ownerId = 'Function:changed')],
    ['chunk count', (v: PreservationPlanInput) => (v.owners[0].chunkCount = 4)],
    ['accepted chunks', (v: PreservationPlanInput) => (v.owners[0].acceptedChunkIndices = [0])],
    ['rejected chunks', (v: PreservationPlanInput) => (v.owners[0].rejectedChunkIndices = [2])],
    ['expected hash', (v: PreservationPlanInput) => (v.owners[0].expectedContentHash = 'hash-b')],
    ['observed hash', (v: PreservationPlanInput) => (v.owners[0].observedContentHash = 'hash-b')],
    ['duplicate', (v: PreservationPlanInput) => (v.owners[0].duplicate = true)],
    ['implicated', (v: PreservationPlanInput) => (v.owners[0].implicated = true)],
  ])('changes planDigest when %s changes', (_name, mutate) => {
    const altered = input();
    mutate(altered);
    expect(planEmbeddingPreservation(altered).planDigest).not.toBe(
      planEmbeddingPreservation(input()).planDigest,
    );
  });
});
