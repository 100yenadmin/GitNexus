import { describe, expect, it, vi } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { EMBEDDING_DIMS } from '../../src/core/lbug/schema.js';

describe('embedding writer identity preflight', () => {
  it('validates the whole batch before executing and prepares once per row', async () => {
    const { batchInsertEmbeddings } =
      await import('../../src/core/embeddings/embedding-pipeline.js');
    const execute = vi.fn(async () => undefined);
    const vector = new Array(EMBEDDING_DIMS).fill(0);

    await batchInsertEmbeddings(execute, [
      { nodeId: 'Function:a', chunkIndex: 0, startLine: 1, endLine: 2, embedding: vector },
      { nodeId: 'Function:b', chunkIndex: 0, startLine: 1, endLine: 2, embedding: vector },
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.every(([, rows]) => rows.length === 1)).toBe(true);

    execute.mockClear();
    await expect(
      batchInsertEmbeddings(execute, [
        { nodeId: 'Function:a', chunkIndex: 0, startLine: 1, endLine: 2, embedding: vector },
        { nodeId: '', chunkIndex: 0, startLine: 1, endLine: 2, embedding: vector },
      ]),
    ).rejects.toThrow(/invalid or duplicate identity\/vector/i);
    expect(execute).not.toHaveBeenCalled();
  });
});

withTestLbugDB(
  'embedding-integrity-scan',
  () => {
    it('finds noncanonical, duplicate-semantic, blank-owner, and orphan rows by scan', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const vector = new Array(EMBEDDING_DIMS).fill(0);
      const cypher =
        'CREATE (e:CodeEmbedding {id: $id, nodeId: $nodeId, chunkIndex: $chunkIndex, ' +
        'startLine: 1, endLine: 2, embedding: $embedding, contentHash: $contentHash})';
      const rows = [
        { id: 'Function:live:0', nodeId: 'Function:live', chunkIndex: 0 },
        { id: 'noncanonical-but-unique', nodeId: 'Function:live', chunkIndex: 0 },
        { id: '', nodeId: 'Function:live', chunkIndex: 1 },
        { id: 'blank-owner:0', nodeId: '', chunkIndex: 0 },
        { id: 'Function:missing:0', nodeId: 'Function:missing', chunkIndex: 0 },
      ];
      for (const row of rows) {
        await adapter.executeWithReusedStatement(cypher, [
          { ...row, embedding: vector, contentHash: 'fixture' },
        ]);
      }

      await expect(adapter.inspectEmbeddingIntegrity()).resolves.toMatchObject({
        tablePresent: true,
        physicalRows: 5,
        validRows: 1,
        recoverableRows: 2,
        emptyIdRows: 1,
        emptyNodeIdRows: 1,
        noncanonicalIdRows: 1,
        duplicateSemanticRows: 1,
        orphanRows: 1,
        wrongDimensionRows: 0,
      });
    });

    it('refuses HNSW creation for the malformed table', async () => {
      const { buildVectorIndex } = await import('../../src/core/embeddings/embedding-pipeline.js');
      await expect(buildVectorIndex()).rejects.toThrow(/refused malformed embedding rows/i);
    });
  },
  {
    seed: [
      "CREATE (:Function {id: 'Function:live', name: 'live', filePath: 'src/live.ts', startLine: 1, endLine: 2, isExported: true, content: '', description: ''})",
    ],
  },
);

withTestLbugDB(
  'embedding-writer-high-volume',
  () => {
    it('keeps every identity canonical across a high-volume real-Ladybug write', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const { batchInsertEmbeddings } =
        await import('../../src/core/embeddings/embedding-pipeline.js');
      const rowCount = 1_024;
      const vector = new Array(EMBEDDING_DIMS).fill(0);
      await batchInsertEmbeddings(
        adapter.executeWithReusedStatement,
        Array.from({ length: rowCount }, (_, chunkIndex) => ({
          nodeId: 'Function:bulk',
          chunkIndex,
          startLine: chunkIndex + 1,
          endLine: chunkIndex + 1,
          embedding: vector,
          contentHash: `chunk-${chunkIndex}`,
        })),
      );

      await expect(adapter.inspectEmbeddingIntegrity()).resolves.toMatchObject({
        tablePresent: true,
        physicalRows: rowCount,
        validRows: rowCount,
        recoverableRows: rowCount,
        emptyIdRows: 0,
        emptyNodeIdRows: 0,
        invalidChunkRows: 0,
        noncanonicalIdRows: 0,
        duplicateIdRows: 0,
        duplicateSemanticRows: 0,
        orphanRows: 0,
        wrongDimensionRows: 0,
      });
    }, 120_000);
  },
  {
    seed: [
      "CREATE (:Function {id: 'Function:bulk', name: 'bulk', filePath: 'src/bulk.ts', startLine: 1, endLine: 2, isExported: true, content: '', description: ''})",
    ],
  },
);

withTestLbugDB(
  'embedding-file-owner',
  (handle) => {
    it('accepts a canonical embedding owned by the File fallback label', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      await expect(adapter.inspectEmbeddingIntegrity()).resolves.toMatchObject({
        physicalRows: 1,
        validRows: 1,
        recoverableRows: 1,
        orphanRows: 0,
      });
    });

    it('rejects a same-count snapshot with a different semantic identity set', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const { createEmbeddingSnapshot, embeddingSnapshotMatchesIdentityDigest } =
        await import('../../src/core/embeddings/cache-snapshot.js');
      const snapshotPath = `${handle.tmpHandle.dbPath}/different-identity.jsonl`;
      const source = { lastCommit: 'fixture', indexedAt: '2026-07-22T00:00:00.000Z' };
      const info = await createEmbeddingSnapshot(snapshotPath, source, async () => [
        {
          nodeId: 'File:stale',
          chunkIndex: 0,
          startLine: 1,
          endLine: 1,
          embedding: new Array(EMBEDDING_DIMS).fill(0),
          contentHash: 'stale',
        },
      ]);
      const live = await adapter.inspectEmbeddingIntegrity();

      expect(info.count).toBe(live.recoverableRows);
      expect(embeddingSnapshotMatchesIdentityDigest(info, live.recoverableIdentitySha256)).toBe(
        false,
      );
    });
  },
  {
    seed: ["CREATE (:File {id: 'File:live', name: 'live.ts', filePath: 'live.ts', content: ''})"],
    beforeFTS: async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const { batchInsertEmbeddings } =
        await import('../../src/core/embeddings/embedding-pipeline.js');
      await batchInsertEmbeddings(adapter.executeWithReusedStatement, [
        {
          nodeId: 'File:live',
          chunkIndex: 0,
          startLine: 1,
          endLine: 1,
          embedding: new Array(EMBEDDING_DIMS).fill(0),
          contentHash: 'live',
        },
      ]);
    },
  },
);

withTestLbugDB(
  'embedding-preservation-scan',
  () => {
    it('returns only deterministic, byte-preservable rows and implicated owners', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const before = await adapter.executeQuery('MATCH (e:CodeEmbedding) RETURN e');
      const scan = await adapter.scanEmbeddingPreservationRows();
      const after = await adapter.executeQuery('MATCH (e:CodeEmbedding) RETURN e');

      expect(scan.physicalRows).toBe(9);
      expect(scan.rejectedRows + scan.acceptedRows.length).toBe(scan.physicalRows);
      expect(scan.acceptedRows.map(({ id }) => id)).toEqual(['Function:good:0']);
      expect(scan.acceptedRows[0]).toMatchObject({
        id: 'Function:good:0',
        nodeId: 'Function:good',
        chunkIndex: 0,
        contentHash: 'good',
      });
      expect(scan.acceptedRows[0]?.embedding).toEqual(new Array(EMBEDDING_DIMS).fill(0.25));
      expect(scan.implicatedOwnerIds).toEqual([
        'Function:bad',
        'Function:duplicate-a',
        'Function:duplicate-b',
        'Function:invalid',
        'Function:missing',
        'Function:semantic',
      ]);
      expect(after).toEqual(before);
    });
  },
  {
    seed: [
      "CREATE (:Function {id: 'Function:good'}), (:Function {id: 'Function:semantic'}), (:Function {id: 'Function:bad'}), (:Function {id: 'Function:duplicate-a'}), (:Function {id: 'Function:duplicate-b'}), (:Function {id: 'Function:invalid'})",
    ],
    beforeFTS: async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      await adapter.executeQuery('DROP TABLE CodeEmbedding');
      await adapter.executeQuery(
        'CREATE NODE TABLE CodeEmbedding (rowKey STRING PRIMARY KEY, id STRING, nodeId STRING, ' +
          'chunkIndex INT64, startLine INT64, endLine INT64, embedding FLOAT[], contentHash STRING)',
      );
      const vector = new Array(EMBEDDING_DIMS).fill(0.25);
      const row = (
        id: string,
        nodeId: string,
        chunkIndex: number,
        embedding = vector,
        contentHash = id,
      ) => ({
        rowKey: `${id}-${nodeId}`,
        id,
        nodeId,
        chunkIndex,
        startLine: 1,
        endLine: 2,
        embedding,
        contentHash,
      });
      await adapter.executeWithReusedStatement(
        'CREATE (e:CodeEmbedding {rowKey: $rowKey, id: $id, nodeId: $nodeId, chunkIndex: $chunkIndex, startLine: $startLine, endLine: $endLine, embedding: $embedding, contentHash: $contentHash})',
        [
          row('Function:good:0', 'Function:good', 0, vector, 'good'),
          row('shared', 'Function:duplicate-a', 0, vector, 'a'),
          row('shared', 'Function:duplicate-b', 0, vector, 'b'),
          row('Function:semantic:0', 'Function:semantic', 0, vector, 's1'),
          row('semantic-copy', 'Function:semantic', 0, vector, 's2'),
          row('wrong', 'Function:bad', 0, vector.slice(0, -1), 'bad'),
          row('Function:missing:0', 'Function:missing', 0, vector, 'missing'),
          row('Function:invalid:-1', 'Function:invalid', -1, vector, 'invalid'),
          row('blank-owner', '', 0, vector, 'blank'),
        ],
      );
    },
  },
);
