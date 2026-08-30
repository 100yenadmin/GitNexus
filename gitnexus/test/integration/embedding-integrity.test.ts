import { describe, expect, it, vi } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { EMBEDDING_DIMS } from '../../src/core/lbug/schema.js';
import { probeRegistryDatabaseCounts } from '../../src/cli/registry-doctor.js';
import * as d from '../../src/core/embeddings/identity-digest.js';

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
  (handle) => {
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
        { id: 'Function:null-chunk:0', nodeId: 'Function:live', chunkIndex: null as any },
      ];
      for (const row of rows) {
        await adapter.executeWithReusedStatement(cypher, [
          { ...row, embedding: vector, contentHash: 'fixture' },
        ]);
      }

      await expect(adapter.inspectEmbeddingIntegrity()).resolves.toMatchObject({
        tablePresent: true,
        physicalRows: 6,
        validRows: 1,
        recoverableRows: 2,
        emptyIdRows: 1,
        emptyNodeIdRows: 1,
        invalidChunkRows: 1,
        noncanonicalIdRows: 1,
        duplicateSemanticRows: 1,
        orphanRows: 1,
        wrongDimensionRows: 0,
      });

      await adapter.executeQuery('DROP TABLE CodeRelation');
      await adapter.executeQuery('DROP TABLE Class');
      await expect(adapter.getStoredEmbeddingDimensions()).resolves.toBe(EMBEDDING_DIMS);
      await expect(adapter.inspectEmbeddingIntegrity(EMBEDDING_DIMS + 1)).resolves.toMatchObject({
        validRows: 0,
        recoverableRows: 0,
        wrongDimensionRows: 6,
      });
    });

    it('refuses HNSW creation for the malformed table', async () => {
      const { buildVectorIndex } = await import('../../src/core/embeddings/embedding-pipeline.js');
      await expect(buildVectorIndex()).rejects.toThrow(/refused malformed embedding rows/i);
    });

    it('only tolerates an exact binder missing-owner-table error', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      expect(
        adapter.isMissingEmbeddingOwnerTableError(
          new Error('Binder exception: Table Class does not exist.'),
          'Class',
        ),
      ).toBe(true);
      expect(
        adapter.isMissingEmbeddingOwnerTableError(
          new Error('Runtime exception: Table Class does not exist.'),
          'Class',
        ),
      ).toBe(false);
      expect(
        adapter.isMissingEmbeddingOwnerTableError(
          new Error('Binder exception: Table Function does not exist.'),
          'Class',
        ),
      ).toBe(false);
      const isMissingContentHash = (suffix: string) =>
        adapter.isMissingContentHashError(
          new Error(`Binder exception: Cannot find property ${suffix}`),
        );
      expect(
        ['contentHash', 'contentHash for e.', 'contentHash text'].map(isMissingContentHash),
      ).toEqual([true, true, false]);
    });

    it('preserves counts when a present legacy table lacks chunkIndex', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const vector = new Array(EMBEDDING_DIMS).fill(0);
      await adapter.executeQuery('DROP TABLE CodeEmbedding');
      await adapter.executeQuery(
        `CREATE NODE TABLE CodeEmbedding (id STRING, nodeId STRING, embedding FLOAT[${EMBEDDING_DIMS}], PRIMARY KEY (id))`,
      );
      await adapter.executeWithReusedStatement(
        'CREATE (e:CodeEmbedding {id: $id, nodeId: $nodeId, embedding: $embedding})',
        [{ id: 'Function:live', nodeId: 'Function:live', embedding: vector }],
      );
      await adapter.flushWAL();

      await expect(probeRegistryDatabaseCounts(handle.dbPath)).resolves.toMatchObject({
        nodes: 1,
        edges: 0,
        embeddings: 1,
        integrity: { status: 'unavailable', reason: 'identity-scan-unavailable' },
      });
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
    it('tracks physical values, rejected state, owner state, and multiset order', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const read = () => adapter.inspectEmbeddingIntegrity(EMBEDDING_DIMS, true);
      const vi = d.embeddingPhysicalVectorInfo;
      const nonfinite = new Array(EMBEDDING_DIMS).fill(0.5);
      nonfinite[0] = Infinity;
      expect((await adapter.inspectEmbeddingIntegrity()).physicalRowsSha256).toBe('');
      const base = await read();
      await adapter.executeWithReusedStatement(
        'MATCH (e:CodeEmbedding) WHERE e.id = $id SET e.contentHash = $hash',
        [{ id: 'File:live:0', hash: 'changed' }],
      );
      const hashChanged = await read();
      expect(hashChanged.physicalRowsSha256).not.toBe(base.physicalRowsSha256);
      await adapter.executeWithReusedStatement(
        'MATCH (e:CodeEmbedding) WHERE e.id = $id SET e.embedding = $embedding',
        [{ id: 'File:live:0', embedding: new Array(EMBEDDING_DIMS).fill(0.5) }],
      );
      const vectorChanged = await read();
      expect(vectorChanged.physicalRowsSha256).not.toBe(hashChanged.physicalRowsSha256);
      await adapter.executeWithReusedStatement(
        'MATCH (e:CodeEmbedding) WHERE e.id = $id SET e.chunkIndex = $chunkIndex',
        [{ id: 'File:live:0', chunkIndex: 1 }],
      );
      expect((await read()).physicalRowsSha256).not.toBe(vectorChanged.physicalRowsSha256);
      await adapter.executeWithReusedStatement(
        'CREATE (e:CodeEmbedding {id: $id, nodeId: $nodeId, chunkIndex: $chunkIndex, ' +
          'startLine: 1, endLine: 1, embedding: $embedding, contentHash: $hash})',
        [
          {
            id: 'File:bad:0',
            nodeId: 'File:bad',
            chunkIndex: 0,
            embedding: nonfinite,
            hash: 'bad',
          },
        ],
      );
      const rejected = await read();
      expect(rejected.physicalRowsSha256).not.toBe(vectorChanged.physicalRowsSha256);
      await adapter.executeQuery("CREATE (:File {id: 'File:bad'})");
      expect((await read()).physicalRowsSha256).not.toBe(rejected.physicalRowsSha256);
      expect(d.embeddingPhysicalRowsDigest(true, 3, ['a', 'b', 'a'])).toBe(
        d.embeddingPhysicalRowsDigest(true, 3, ['a', 'a', 'b']),
      );
      expect(vi(new Int32Array(EMBEDDING_DIMS)).finite).toBe('malformed');
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
  'embedding-preservation-stream',
  () => {
    it('emits only deterministic accepted rows in bounded batches under the WAL driver', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const { markWalDriverActive } = await import('../../src/core/lbug/wal-driver-state.js');
      const snapshot = () =>
        adapter.executeQuery('MATCH (e:CodeEmbedding) RETURN e ORDER BY e.rowKey');
      const before = await snapshot();
      const retained: Array<readonly { id: string }[]> = [];
      let firstReport: Awaited<ReturnType<typeof adapter.scanEmbeddingPreservationRows>>;
      markWalDriverActive(true);
      try {
        firstReport = await adapter.scanEmbeddingPreservationRows({
          onBatch: (batch) => retained.push(batch),
        });
      } finally {
        markWalDriverActive(false);
      }
      const secondBatches: string[][] = [];
      const secondReport = await adapter.scanEmbeddingPreservationRows({
        onBatch: (batch) => {
          expect(batch.every((row) => row.contentHash === undefined)).toBe(true);
          secondBatches.push(batch.map((row) => row.id));
        },
      });
      const scans = [retained.map((batch) => batch.map((row) => row.id)), secondBatches];
      const after = await snapshot();

      expect(firstReport).toMatchObject({ physicalRows: 265, acceptedRows: 257, rejectedRows: 8 });
      expect(firstReport).toMatchObject({
        duplicateIdRows: 1,
        duplicateSemanticRows: 1,
        invalidLineRows: 0,
        nonfiniteRows: 1,
        malformedVectorRows: 1,
        missingContentHashRows: 0,
        labelMismatchRows: 2,
      });
      expect(firstReport.physicalRowsSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(firstReport.rejectedRowsSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(firstReport.acceptedPayloadSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(secondReport).toEqual(firstReport);
      expect(firstReport.implicatedOwnerIds.join(',')).toBe(
        'Function:bad,Function:cross,Function:dup-a,Function:dup-b,Function:null,Function:semantic,Trait:legacy',
      );
      expect(firstReport.missingOwnerLabels).toEqual(['Trait']);
      expect(scans[0]?.map((batch) => batch.length)).toEqual([256, 1]);
      expect(scans[1]).toEqual(scans[0]);
      expect(scans[0]?.flat()).toEqual([...scans[0]!.flat()].sort());
      expect(after).toEqual(before);
    });
  },
  {
    seed: [
      "CREATE (:Function {id: 'Function:bad'}), (:Function {id: 'Function:dup-a'}), (:Function {id: 'Function:dup-b'}), (:Function {id: 'Function:null'}), (:Function {id: 'Function:semantic'}), (:Class {id: 'Function:cross'}), (:Trait {id: 'Trait:legacy'})",
    ],
    beforeFTS: async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      await adapter.executeQuery('DROP TABLE CodeEmbedding');
      await adapter.executeQuery('DROP TABLE CodeRelation');
      await adapter.executeQuery('DROP TABLE Trait');
      await adapter.executeQuery(
        'CREATE NODE TABLE CodeEmbedding (rowKey STRING PRIMARY KEY, id STRING, nodeId STRING, chunkIndex INT64, startLine INT64, endLine INT64, embedding FLOAT[])',
      );
      const vector = new Array(EMBEDDING_DIMS).fill(0.25);
      await adapter.executeWithReusedStatement(
        'CREATE (:Function {id: $id})',
        Array.from({ length: 1_281 }, (_, index) => ({
          id: `Function:${index < 257 ? 'bulk' : 'unused'}-${index}`,
        })),
      );
      const row = (id: string, nodeId: string, chunkIndex: number, embedding = vector) => ({
        rowKey: `${id}-${nodeId}`,
        id,
        nodeId,
        chunkIndex,
        embedding,
      });
      await adapter.executeWithReusedStatement(
        'CREATE (e:CodeEmbedding {rowKey: $rowKey, id: $id, nodeId: $nodeId, chunkIndex: $chunkIndex, startLine: 1, endLine: 2, embedding: $embedding})',
        [
          ...Array.from({ length: 257 }, (_, index) =>
            row(`Function:bulk-${index}:0`, `Function:bulk-${index}`, 0),
          ),
          row('Function:bad:0', 'Function:bad', 0, [Infinity, ...vector.slice(1)]),
          row('shared', 'Function:dup-a', 0),
          row('shared', 'Function:dup-b', 0),
          row('Function:semantic:0', 'Function:semantic', 0),
          row('other', 'Function:semantic', 0),
          row('Function:null:0', 'Function:null', 0, [null, ...vector.slice(1)] as number[]),
          row('Function:cross:0', 'Function:cross', 0),
          row('Trait:legacy:0', 'Trait:legacy', 0),
        ],
      );
    },
  },
);

withTestLbugDB(
  'embedding-preservation-proof',
  () => {
    it('binds owners and proves stable accepted and rejected payload state', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const vector = new Array(EMBEDDING_DIMS).fill(0);
      const accepted: any[] = [];
      const base = await adapter.scanEmbeddingPreservationRows({
        onBatch: (b) => accepted.push(...b),
      });
      expect(base).toMatchObject({
        physicalRows: 5,
        acceptedRows: 1,
        rejectedRows: 4,
        invalidLineRows: 1,
        missingContentHashRows: 1,
        labelMismatchRows: 2,
      });
      const integrity = await adapter.inspectEmbeddingIntegrity(EMBEDDING_DIMS, true);
      expect(base.physicalRowsSha256).toBe(integrity.physicalRowsSha256);
      expect(base.acceptedRows).toBe(integrity.validRows);
      expect(d.embeddingAcceptedPayloadDigest([...accepted].reverse())).toBe(
        base.acceptedPayloadSha256,
      );
      await adapter.executeWithReusedStatement(
        'MATCH (e:CodeEmbedding) WHERE e.id = $id SET e.embedding = $embedding',
        [{ id: 'Function:ok:0', embedding: new Array(EMBEDDING_DIMS).fill(0.5) }],
      );
      const byteChanged = await adapter.scanEmbeddingPreservationRows();
      expect(byteChanged.acceptedPayloadSha256).not.toBe(base.acceptedPayloadSha256);
      await adapter.executeWithReusedStatement(
        'MATCH (e:CodeEmbedding) WHERE e.id = $id SET e.contentHash = $hash',
        [{ id: 'Function:bad:0', hash: 'drift' }],
      );
      const rejectedDrift = await adapter.scanEmbeddingPreservationRows();
      expect(rejectedDrift.rejectedRows).toBe(base.rejectedRows);
      expect(rejectedDrift.rejectedRowsSha256).not.toBe(base.rejectedRowsSha256);
      await adapter.executeWithReusedStatement(
        'MATCH (e:CodeEmbedding) WHERE e.id = $id SET e.embedding = $embedding',
        [{ id: 'Function:ok:0', embedding: [Infinity, ...vector.slice(1)] }],
      );
      const nonfinite = await adapter.scanEmbeddingPreservationRows();
      expect(nonfinite).toMatchObject({ acceptedRows: 0, nonfiniteRows: 1 });
    });
  },
  {
    seed: [
      "CREATE (:Function {id: 'Function:ok'}), (:Function {id: 'Function:blank'}), (:Function {id: 'Function:line'}), (:Class {id: 'Function:misbound'})",
    ],
    beforeFTS: async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const vector = new Array(EMBEDDING_DIMS).fill(0);
      await adapter.executeWithReusedStatement(
        'CREATE (e:CodeEmbedding {id: $id, nodeId: $nodeId, chunkIndex: 0, startLine: $startLine, endLine: 2, embedding: $embedding, contentHash: $hash})',
        [
          {
            id: 'Function:ok:0',
            nodeId: 'Function:ok',
            startLine: 1,
            embedding: vector,
            hash: 'ok',
          },
          {
            id: 'Function:blank:0',
            nodeId: 'Function:blank',
            startLine: 1,
            embedding: vector,
            hash: '',
          },
          {
            id: 'Function:line:0',
            nodeId: 'Function:line',
            startLine: null,
            embedding: vector,
            hash: 'line',
          },
          {
            id: 'Function:misbound:0',
            nodeId: 'Function:misbound',
            startLine: 1,
            embedding: vector,
            hash: 'owner',
          },
          {
            id: 'Function:bad:0',
            nodeId: 'Function:bad',
            startLine: 1,
            embedding: vector,
            hash: 'bad',
          },
        ],
      );
    },
  },
);
