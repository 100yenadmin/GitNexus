import { describe, expect, it } from 'vitest';
import {
  buildEmbeddingPreservationPreview,
  buildEmbeddingPreservationPreviewFromNodes,
  type PreservationPreviewBase,
  type PreservationPreviewScan,
} from '../../src/core/embeddings/preservation-preview.js';
import {
  PRESERVATION_PLAN_SCHEMA,
  PRESERVATION_PLANNER_VERSION,
} from '../../src/core/embeddings/preservation-plan.js';
import type { EmbeddableNode } from '../../src/core/embeddings/types.js';

const base: PreservationPreviewBase = {
  schemaVersion: PRESERVATION_PLAN_SCHEMA,
  plannerVersion: PRESERVATION_PLANNER_VERSION,
  source: { head: 'head-a', branch: 'main', worktree: '/repo' },
  storage: {
    database: { canonicalPath: '/repo/.gitnexus/lbug', sha256: 'db-a' },
    metadata: {
      canonicalPath: '/repo/.gitnexus/gitnexus.json',
      sha256: 'meta-a',
    },
  },
  embedding: {
    provider: 'local',
    transport: 'onnx',
    model: 'model-a',
    dimensions: 384,
    textVersion: 'v4',
  },
};

const scan = (overrides: Partial<PreservationPreviewScan> = {}): PreservationPreviewScan => ({
  physicalRows: 3,
  acceptedRows: 2,
  rejectedRows: 1,
  physicalRowsSha256: 'physical-a',
  rejectedRowsSha256: 'rejected-a',
  acceptedPayloadSha256: 'accepted-a',
  implicatedOwnerIds: [],
  ...overrides,
});

const owner = (nodeId: string, contentHash: string, chunkIndices = [0, 1]) => ({
  nodeId,
  label: 'Function',
  contentHash,
  chunkIndices,
});

const row = (nodeId: string, chunkIndex: number, contentHash?: string) => ({
  id: `${nodeId}:${chunkIndex}`,
  nodeId,
  chunkIndex,
  ...(contentHash === undefined ? {} : { contentHash }),
});

describe('provider-free preservation preview core', () => {
  it('includes every current owner and is independent of input order', () => {
    const input = {
      base,
      scan: scan({ physicalRows: 4, acceptedRows: 3, rejectedRows: 1 }),
      acceptedRows: [
        row('Function:a', 0, 'a'),
        row('Function:a', 1, 'a'),
        row('Function:b', 0, 'old'),
      ],
      owners: [owner('Function:b', 'b'), owner('Function:a', 'a'), owner('Function:empty', 'e')],
    };
    const plan = buildEmbeddingPreservationPreview(input);
    const reordered = buildEmbeddingPreservationPreview({
      ...input,
      acceptedRows: [...input.acceptedRows].reverse(),
      owners: [...input.owners].reverse(),
    });

    expect(plan.planDigest).toBe(reordered.planDigest);
    expect(plan.observations.map(({ ownerId }) => ownerId)).toEqual([
      'Function:a',
      'Function:b',
      'Function:empty',
    ]);
    expect(plan.restoreIdentities).toEqual(['Function:a:0', 'Function:a:1']);
    expect(plan.reembedOwners).toEqual(['Function:b', 'Function:empty']);
  });

  it('re-embeds whole owners for missing, mismatched, duplicate, and rejected state', () => {
    const plan = buildEmbeddingPreservationPreview({
      base,
      scan: scan({
        physicalRows: 6,
        acceptedRows: 5,
        rejectedRows: 1,
        implicatedOwnerIds: ['Function:rejected', 'orphan:bad'],
        duplicateOwnerIds: ['Function:duplicate'],
      }),
      acceptedRows: [
        row('Function:keep', 0, 'keep'),
        row('Function:keep', 1, 'keep'),
        row('Function:mismatch', 0, 'old'),
        row('Function:mismatch', 1, 'old'),
        row('Function:duplicate', 0, 'duplicate'),
      ],
      owners: [
        owner('Function:keep', 'keep'),
        owner('Function:mismatch', 'new'),
        owner('Function:duplicate', 'duplicate'),
        owner('Function:missing', 'missing'),
        owner('Function:rejected', 'rejected'),
      ],
    });

    expect(plan.restoreIdentities).toEqual(['Function:keep:0', 'Function:keep:1']);
    expect(plan.reembedOwners).toEqual([
      'Function:duplicate',
      'Function:mismatch',
      'Function:missing',
      'Function:rejected',
    ]);
    expect(plan.counts.reembedChunkCount).toBe(8);
    expect(plan.observations.some(({ ownerId }) => ownerId === 'orphan:bad')).toBe(false);
  });

  it('derives chunks and hashes through injected existing pipeline functions', async () => {
    const nodes: EmbeddableNode[] = [
      {
        id: 'Function:b',
        name: 'b',
        label: 'Function',
        filePath: 'b.ts',
        content: 'b',
      },
      {
        id: 'Function:a',
        name: 'a',
        label: 'Function',
        filePath: 'a.ts',
        content: 'a',
      },
    ];
    const plan = await buildEmbeddingPreservationPreviewFromNodes({
      base,
      scan: scan({ physicalRows: 2, acceptedRows: 2, rejectedRows: 0 }),
      acceptedRows: [row('Function:a', 0, 'hash-a'), row('Function:b', 0, 'hash-b')],
      nodes,
      derivation: {
        chunkIndicesForNode: async (node) => (node.id === 'Function:a' ? [0] : [0]),
        contentHashForNode: (node) => `hash-${node.id.slice(-1)}`,
      },
    });

    expect(plan.reembedOwners).toEqual([]);
    expect(plan.restoreIdentities).toEqual(['Function:a:0', 'Function:b:0']);
  });
});
