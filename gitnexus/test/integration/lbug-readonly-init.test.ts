/**
 * Integration Tests: read-only doInitLbug path (#1783)
 *
 * Verifies that read-only LadybugDB opens skip filesystem mutations
 * (init lock, orphan sidecar cleanup, mkdir) so they work on read-only
 * filesystems such as Docker :ro bind mounts.
 */
import fs from 'fs/promises';
import http from 'node:http';
import path from 'node:path';
import { it, expect, vi } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { _initLockPathForTest } from '../../src/core/lbug/lbug-adapter.js';
import { closeQueryResults } from '../../src/core/lbug/query-result-utils.js';
import { EMBEDDING_DIMS } from '../../src/core/lbug/schema.js';
import type { RegistryEntry, RepoMeta } from '../../src/storage/repo-manager.js';

const allocatePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') return reject(new Error('no test port'));
      probe.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });

const waitForJob = async (baseUrl: string, jobId: string) => {
  for (let attempt = 0; attempt < 3000; attempt++) {
    const response = await fetch(`${baseUrl}/api/embed/${jobId}`);
    const job = (await response.json()) as { status: string; error?: string };
    if (job.status === 'complete' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('native embed job did not finish');
};

withTestLbugDB(
  'lbug-readonly-init',
  (handle) => {
    it('read-only open never creates lbug.init.lock on disk', async () => {
      const { dbPath } = handle;
      const lockPath = _initLockPathForTest(dbPath);

      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      await adapter.closeLbug();

      await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });

      await adapter.withLbugDb(dbPath, async () => {}, { readOnly: true });

      await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });

      await adapter.closeLbug();
    });

    it('runs legacy preflight and writable revalidation through native LadybugDB', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const storagePath = path.dirname(handle.dbPath);
      const repoPath = path.join(storagePath, 'repo-root');
      await fs.mkdir(repoPath, { recursive: true });
      await fs.symlink(
        storagePath,
        path.join(repoPath, '.gitnexus'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const repo: RegistryEntry = {
        name: 'native-legacy',
        path: repoPath,
        storagePath,
        indexedAt: '2026-08-23T00:00:00.000Z',
        lastCommit: 'native-head',
      };
      const legacyMeta = (): RepoMeta => ({
        repoPath: repo.path,
        indexedAt: repo.indexedAt,
        lastCommit: repo.lastCommit,
        stats: { embeddings: 0 },
        embeddingCheckpoint: {
          at: repo.indexedAt,
          nodesProcessed: 0,
          totalNodes: 0,
          chunksProcessed: 0,
          model: 'legacy-model',
          dimensions: EMBEDDING_DIMS,
          pendingNodeIds: [],
        },
      });
      let meta = legacyMeta();
      let loadCount = 0;
      let injectWritableDrift = false;
      const zeroVector = new Array(EMBEDDING_DIMS).fill(0).join(',');
      const loadMeta = vi.fn(async () => {
        loadCount++;
        if (injectWritableDrift && loadCount === 3) {
          // This callback runs inside withLbugDb's serialized session. Calling
          // adapter.executeQuery here would recursively wait on that same
          // session lock. Use a second native connection on the already-open
          // Database so the fixture can inject the between-preflight drift
          // without weakening production's single-session boundary.
          const db = adapter.getDatabase();
          if (!db) throw new Error('native drift fixture has no open Database');
          const lbug = (await import('@ladybugdb/core')).default;
          const driftConnection = new lbug.Connection(db);
          try {
            const result = await driftConnection.query(
              `CREATE (e:CodeEmbedding {id:'native-row', nodeId:'Function:native.ts:run', chunkIndex:0, startLine:1, endLine:1, embedding:[${zeroVector}], contentHash:'native-hash'})`,
            );
            await closeQueryResults(result);
          } finally {
            await driftConnection.close().catch(() => {});
          }
        }
        return meta;
      });
      const pipeline = vi.fn(async () => {
        expect(loadCount).toBe(3);
        const rows = (await adapter.executeQuery(
          "MATCH (n:Function {id:'Function:native.ts:run'}) RETURN n.id AS id",
        )) as Array<{ id: string }>;
        expect(rows).toEqual([{ id: 'Function:native.ts:run' }]);
      });
      const saveMeta = vi.fn(async (_storagePath: string, next: RepoMeta) => {
        meta = next;
      });

      vi.doMock('../../src/storage/repo-manager.js', async (importActual) => ({
        ...(await importActual<typeof import('../../src/storage/repo-manager.js')>()),
        listRegisteredRepos: vi.fn(async () => [repo]),
        loadMeta,
        saveMeta,
      }));
      vi.doMock('../../src/core/embeddings/embedder.js', () => ({
        getActiveEmbeddingIdentity: vi.fn(() => ({
          provider: 'native-test',
          model: 'native-model',
          dimensions: EMBEDDING_DIMS,
        })),
      }));
      vi.doMock('../../src/core/embeddings/embedding-pipeline.js', () => ({
        runEmbeddingPipeline: pipeline,
      }));
      vi.doMock('../../src/mcp/local/local-backend.js', () => ({
        LocalBackend: class {
          async init(): Promise<void> {}
          async disconnect(): Promise<void> {}
        },
      }));
      vi.doMock('../../src/server/mcp-http.js', () => ({
        mountMCPEndpoints: () => async (): Promise<void> => {},
      }));
      vi.doMock('../../src/server/analyze-launch.js', () => ({
        createLaunchAnalysisWorker: () => (): void => {},
      }));
      vi.doMock('../../src/server/analyze-upload.js', () => ({
        createAnalyzeUploadHandler: () => (_req: unknown, _res: unknown, next: () => void) =>
          next(),
      }));
      vi.doMock('../../src/server/upload-sweep.js', () => ({
        sweepStaleUploads: async (): Promise<void> => {},
      }));

      let shutdown: (() => Promise<void>) | undefined;
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      const originalOnce = process.once.bind(process);
      const onceSpy = vi.spyOn(process, 'once').mockImplementation(((
        event: string,
        listener: Function,
      ) => {
        if (event === 'SIGTERM') {
          shutdown = listener as () => Promise<void>;
        }
        if (event === 'SIGINT' || event === 'SIGTERM') return process;
        return originalOnce(event, listener);
      }) as typeof process.once);
      const onSpy = vi.spyOn(process, 'on').mockImplementation(() => process);
      const port = await allocatePort();
      const { createServer } = await import('../../src/server/api.js');
      await createServer(port, '127.0.0.1');
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        const submit = async () => {
          const response = await fetch(`${baseUrl}/api/embed`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ repo: repo.name }),
          });
          const payload = (await response.json()) as { jobId?: string; error?: string };
          if (!payload.jobId)
            throw new Error(payload.error ?? `embed submission failed (${response.status})`);
          const jobId = payload.jobId;
          return waitForJob(baseUrl, jobId);
        };
        expect((await submit()).status).toBe('complete');
        expect(pipeline).toHaveBeenCalledOnce();

        meta = legacyMeta();
        loadCount = 0;
        injectWritableDrift = true;
        const refused = await submit();
        expect(refused.status).toBe('failed');
        expect(refused.error).toMatch(/unknown-provider while the table contains rows/i);
        expect(pipeline).toHaveBeenCalledOnce();
      } finally {
        onSpy.mockRestore();
        onceSpy.mockRestore();
        await shutdown?.();
        exitSpy.mockRestore();
      }
    });
  },
  {
    seed: [
      "CREATE (f:Function {id:'Function:native.ts:run', name:'run', filePath:'native.ts', startLine:1, endLine:1, content:'function run() {}', description:''})",
    ],
  },
);
