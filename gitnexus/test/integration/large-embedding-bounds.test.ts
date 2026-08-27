import { beforeEach, describe, expect, it, vi } from 'vitest';

const { embedBatchMock, createVectorIndexMock } = vi.hoisted(() => ({
  embedBatchMock: vi.fn(),
  createVectorIndexMock: vi.fn(async () => true),
}));

vi.mock('../../src/core/embeddings/embedder.js', () => ({
  initEmbedder: vi.fn(async () => undefined),
  embedBatch: embedBatchMock,
  embedText: vi.fn(async () => new Float32Array(2_048)),
  embeddingToArray: (embedding: Float32Array) => Array.from(embedding),
  isEmbedderReady: vi.fn(() => true),
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  loadVectorExtension: vi.fn(async () => true),
  createVectorIndex: createVectorIndexMock,
  inspectEmbeddingIntegrity: vi.fn(async () => ({
    tablePresent: true,
    physicalRows: 25_000,
    validRows: 25_000,
    recoverableRows: 25_000,
    emptyIdRows: 0,
    emptyNodeIdRows: 0,
    invalidChunkRows: 0,
    noncanonicalIdRows: 0,
    duplicateIdRows: 0,
    duplicateSemanticRows: 0,
    orphanRows: 0,
    wrongDimensionRows: 0,
    recoverableIdentitySha256: '0'.repeat(64),
    physicalRowsSha256: '0'.repeat(64),
  })),
  embeddingIntegrityFailures: vi.fn(() => 0),
}));

vi.mock('../../src/core/lbug/schema.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/lbug/schema.js')>()),
  EMBEDDING_DIMS: 2_048,
}));

import { runEmbeddingPipeline } from '../../src/core/embeddings/embedding-pipeline.js';

const NODE_COUNT = 25_000;
const PAGE_SIZE = 512;

const idFor = (index: number): string =>
  `Function:node-${String(index).padStart(5, '0')}:src/generated.ts`;

const rowFor = (index: number) => ({
  id: idFor(index),
  name: `node${index}`,
  label: 'Function',
  filePath: 'src/generated.ts',
  content: `function node${index}() { return ${index}; }`,
  startLine: index + 1,
  endLine: index + 1,
});

describe('25k x 2,048 bounded embedding integration', () => {
  beforeEach(() => {
    embedBatchMock
      .mockReset()
      .mockImplementation(async (texts: string[]) => texts.map(() => new Float32Array(2_048)));
    createVectorIndexMock.mockClear();
  });

  it('holds node pages at 512, checkpoint windows at 5,000, vectors at 8, and writes one identity at a time', async () => {
    const queryPageSizes: number[] = [];
    const identityPageSizes: number[] = [];
    const checkpointWindowSizes: number[] = [];
    let inserted = 0;
    let maxInsertBatch = 0;
    let maxHeapUsed = process.memoryUsage().heapUsed;
    const startHeapUsed = maxHeapUsed;

    const executeQuery = vi.fn(async (cypher: string) => {
      maxHeapUsed = Math.max(maxHeapUsed, process.memoryUsage().heapUsed);
      if (!cypher.includes('MATCH (n:`Function`)')) return [];
      const inMatch = cypher.match(/WHERE n\.id IN \[(.*?)\] RETURN/s);
      if (inMatch) {
        const ids = [...inMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
        queryPageSizes.push(ids.length);
        return ids.map((id) => rowFor(Number(id.match(/node-(\d+)/)?.[1] ?? -1)));
      }
      const afterIndex = Number(cypher.match(/WHERE n\.id > 'Function:node-(\d+)/)?.[1] ?? -1);
      const start = afterIndex >= 0 ? afterIndex + 1 : 0;
      const size = Math.min(PAGE_SIZE, NODE_COUNT - start);
      queryPageSizes.push(Math.max(0, size));
      return Array.from({ length: Math.max(0, size) }, (_, offset) => rowFor(start + offset));
    });

    const executeWithReusedStatement = vi.fn(async (cypher: string, params: unknown[]) => {
      maxHeapUsed = Math.max(maxHeapUsed, process.memoryUsage().heapUsed);
      if (!cypher.includes('CREATE')) return;
      inserted += params.length;
      maxInsertBatch = Math.max(maxInsertBatch, params.length);
      for (const param of params as Array<{ embedding: number[] }>) {
        expect(param.embedding).toHaveLength(2_048);
      }
    });

    const result = await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      () => {},
      { batchSize: 64, subBatchSize: 64 },
      undefined,
      undefined,
      {
        loadExistingEmbeddingHashes: async (nodeIds) => {
          identityPageSizes.push(nodeIds.length);
          return new Map();
        },
        onCheckpointWindowStart: async ({ nodeIds }) => {
          checkpointWindowSizes.push(nodeIds.length);
        },
      },
    );

    expect(result.nodesProcessed).toBe(NODE_COUNT);
    expect(inserted).toBe(NODE_COUNT);
    expect(checkpointWindowSizes).toEqual([5_000, 5_000, 5_000, 5_000, 5_000]);
    expect(Math.max(...queryPageSizes)).toBeLessThanOrEqual(PAGE_SIZE);
    expect(Math.max(...identityPageSizes)).toBeLessThanOrEqual(PAGE_SIZE);
    expect(Math.max(...embedBatchMock.mock.calls.map(([texts]) => texts.length))).toBe(8);
    expect(maxInsertBatch).toBe(1);
    expect(maxHeapUsed - startHeapUsed).toBeLessThan(512 * 1024 * 1024);
  });
});
