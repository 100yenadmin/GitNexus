import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { setupMiniRepo } from '../helpers/mini-repo.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';

const EMBEDDING_DIMS = 384;
const EMBEDDING_ENV_KEYS = [
  'GITNEXUS_HOME',
  'GITNEXUS_LBUG_EXTENSION_INSTALL',
  'GITNEXUS_EMBEDDING_URL',
  'GITNEXUS_EMBEDDING_MODEL',
  'GITNEXUS_EMBEDDING_DIMS',
  'GITNEXUS_EMBEDDING_MAX_ATTEMPTS',
  'GITNEXUS_EMBEDDING_RETRY_CAP_MS',
  'GITNEXUS_EMBEDDING_MIN_INTERVAL_MS',
  'GITNEXUS_EMBEDDING_API_KEY',
] as const;

type EmbeddingRow = {
  id: string;
  nodeId: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  contentHash: string;
  embedding: number[];
};

const deterministicEmbedding = (text: string): number[] => {
  const digest = createHash('sha256').update(text).digest();
  return Array.from(
    { length: EMBEDDING_DIMS },
    (_, index) => (digest[index % digest.length]! - 128) / 128,
  );
};

const gitCommitAll = (repoPath: string, message: string): void => {
  execFileSync('git', ['add', '-A'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=test',
      '-c',
      'user.email=t@t',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      message,
    ],
    { cwd: repoPath, stdio: 'pipe' },
  );
};

const readEmbeddingRows = async (repoPath: string): Promise<EmbeddingRow[]> => {
  const adapter = await import('../../src/core/lbug/lbug-adapter.js');
  const { lbugPath } = getStoragePaths(repoPath);
  await adapter.initLbug(lbugPath);
  try {
    const rows = (await adapter.executeQuery(
      'MATCH (e:CodeEmbedding) RETURN e.id AS id, e.nodeId AS nodeId, ' +
        'e.chunkIndex AS chunkIndex, e.startLine AS startLine, e.endLine AS endLine, ' +
        'e.contentHash AS contentHash, e.embedding AS embedding',
    )) as Array<Record<string, unknown>>;
    return rows
      .map((row) => ({
        id: String(row.id ?? row[0] ?? ''),
        nodeId: String(row.nodeId ?? row[1] ?? ''),
        chunkIndex: Number(row.chunkIndex ?? row[2] ?? 0),
        startLine: Number(row.startLine ?? row[3] ?? 0),
        endLine: Number(row.endLine ?? row[4] ?? 0),
        contentHash: String(row.contentHash ?? row[5] ?? ''),
        embedding: Array.isArray(row.embedding)
          ? row.embedding.map(Number)
          : Array.from((row.embedding ?? row[6]) as Iterable<unknown>, Number),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  } finally {
    await adapter.closeLbug();
  }
};

const rowKey = (row: EmbeddingRow): string => `${row.nodeId}:${row.chunkIndex}`;
const rowPayload = (row: EmbeddingRow): string =>
  JSON.stringify({
    id: row.id,
    nodeId: row.nodeId,
    chunkIndex: row.chunkIndex,
    startLine: row.startLine,
    endLine: row.endLine,
    contentHash: row.contentHash,
    embedding: row.embedding,
  });

describe('M8b incremental embedding restore', () => {
  it('restores only missing snapshot PKs during a positive-cap one-file incremental run', async () => {
    const previousEnv = new Map(EMBEDDING_ENV_KEYS.map((key) => [key, process.env[key]] as const));
    const home = await mkdtemp(path.join(os.tmpdir(), 'gitnexus-m8b-restore-home-'));
    const repo = await setupMiniRepo('gitnexus-m8b-restore-');
    try {
      process.env.GITNEXUS_HOME = home;
      process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = 'never';
      process.env.GITNEXUS_EMBEDDING_URL = 'http://in-process.invalid/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'm8b-deterministic';
      process.env.GITNEXUS_EMBEDDING_DIMS = String(EMBEDDING_DIMS);
      process.env.GITNEXUS_EMBEDDING_MAX_ATTEMPTS = '1';
      process.env.GITNEXUS_EMBEDDING_RETRY_CAP_MS = '1';
      process.env.GITNEXUS_EMBEDDING_MIN_INTERVAL_MS = '0';
      delete process.env.GITNEXUS_EMBEDDING_API_KEY;
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { input?: unknown };
        const inputs = Array.isArray(body.input) ? body.input.map(String) : [];
        return new Response(
          JSON.stringify({
            data: inputs.map((text) => ({ embedding: deterministicEmbedding(text) })),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      });
      vi.stubGlobal('fetch', fetchMock);

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const options = {
        skipAgentsMd: true,
        skipSkills: true,
        embeddings: true,
        embeddingsNodeLimit: 1000,
      };
      await runFullAnalysis(repo.dbPath, options, { onProgress: () => {} });
      const before = await readEmbeddingRows(repo.dbPath);
      expect(before.length).toBeGreaterThan(0);
      expect(new Set(before.map((row) => row.id)).size).toBe(before.length);

      const handlerPath = path.join(repo.dbPath, 'src', 'handler.ts');
      const handlerSource = await readFile(handlerPath, 'utf8');
      await writeFile(
        handlerPath,
        handlerSource.replace(
          'return formatResponse(saved);',
          "return formatResponse(saved) + '!';",
        ),
        'utf8',
      );
      gitCommitAll(repo.dbPath, 'm8b restore regression');

      const incremental = await runFullAnalysis(repo.dbPath, options, {
        onProgress: () => {},
      });
      expect(incremental.alreadyUpToDate).not.toBe(true);
      const after = await readEmbeddingRows(repo.dbPath);
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const { lbugPath } = getStoragePaths(repo.dbPath);
      await adapter.initLbug(lbugPath);
      const integrity = await adapter
        .inspectEmbeddingIntegrity(undefined, true)
        .finally(() => adapter.closeLbug());

      const beforeByKey = new Map(before.map((row) => [rowKey(row), row]));
      const afterByKey = new Map(after.map((row) => [rowKey(row), row]));
      const changed = before.filter((row) => {
        const current = afterByKey.get(rowKey(row));
        return current !== undefined && rowPayload(current) !== rowPayload(row);
      });
      const added = after.filter((row) => !beforeByKey.has(rowKey(row)));
      const handlerOwner = (nodeId: string): boolean => /src[\\/]handler\.ts/.test(nodeId);

      expect(integrity.duplicateIdRows).toBe(0);
      expect(integrity.duplicateSemanticRows).toBe(0);
      expect(integrity.physicalRows).toBe(integrity.validRows);
      expect(changed.length + added.length).toBeGreaterThan(0);
      expect([...changed, ...added].every((row) => handlerOwner(row.nodeId))).toBe(true);
      expect(
        before
          .filter((row) => !handlerOwner(row.nodeId))
          .every((row) => rowPayload(afterByKey.get(rowKey(row))!) === rowPayload(row)),
      ).toBe(true);
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      await repo.cleanup();
      await rm(home, { recursive: true, force: true });
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      vi.unstubAllGlobals();
    }
  }, 180_000);
});
