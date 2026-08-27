import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { getStoragePaths, saveMeta, type RepoMeta } from '../../src/storage/repo-manager.js';
import { EMBEDDING_DIMS } from '../../src/core/lbug/schema.js';
import { createTempDir, type TestDBHandle } from '../helpers/test-db.js';

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

describe('VECTOR repair malformed-source byte preservation', () => {
  let fixture: TestDBHandle | undefined;

  afterEach(async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.closeLbug().catch(() => {});
    await fixture?.cleanup();
    fixture = undefined;
  });

  it('rejects through a strict read-only preflight without changing Ladybug bytes', async () => {
    fixture = await createTempDir();
    const repoPath = fixture.dbPath;
    const paths = getStoragePaths(repoPath);
    await fs.mkdir(paths.storagePath, { recursive: true });

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.initLbug(paths.lbugPath);
    await adapter.executeQuery(
      "CREATE (:Function {id: 'Function:live', name: 'live', filePath: 'src/live.ts', " +
        "startLine: 1, endLine: 2, isExported: true, content: '', description: ''})",
    );
    await adapter.executeWithReusedStatement(
      'CREATE (e:CodeEmbedding {id: $id, nodeId: $nodeId, chunkIndex: 0, ' +
        'startLine: 1, endLine: 2, embedding: $embedding, contentHash: $contentHash})',
      [
        {
          id: '',
          nodeId: 'Function:live',
          embedding: new Array(EMBEDDING_DIMS).fill(0),
          contentHash: 'malformed',
        },
      ],
    );
    await adapter.flushWAL();
    await adapter.closeLbug();

    const meta: RepoMeta = {
      repoPath,
      lastCommit: '',
      indexedAt: '2026-07-22T00:00:00.000Z',
      stats: { files: 1, nodes: 1, edges: 0, embeddings: 1 },
      capabilities: {
        graph: { provider: 'ladybugdb', status: 'available' },
        fts: { provider: 'ladybugdb-fts', status: 'available' },
        vectorSearch: {
          provider: 'exact-scan',
          status: 'exact-scan',
          exactScanLimit: 20_000,
        },
      },
    };
    await saveMeta(paths.storagePath, meta);

    const beforeBytes = await fs.readFile(paths.lbugPath);
    const beforeHash = sha256(beforeBytes);
    const beforeEntries = (await fs.readdir(paths.storagePath)).sort();
    const beforeMeta = await fs.readFile(paths.metaPath);

    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
    await expect(
      runFullAnalysis(repoPath, { repairVector: true }, { onProgress: () => {} }),
    ).rejects.toThrow(/source table failed embedding integrity validation/i);

    const afterBytes = await fs.readFile(paths.lbugPath);
    expect(sha256(afterBytes)).toBe(beforeHash);
    expect(afterBytes).toEqual(beforeBytes);
    expect((await fs.readdir(paths.storagePath)).sort()).toEqual(beforeEntries);
    expect(await fs.readFile(paths.metaPath)).toEqual(beforeMeta);
  }, 120_000);
});
