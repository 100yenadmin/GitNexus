import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  createEmbeddingSnapshot,
  readEmbeddingSnapshot,
  validateEmbeddingSnapshot,
} from '../../src/core/embeddings/cache-snapshot.js';
import type { CachedEmbedding } from '../../src/core/embeddings/types.js';

const tempDirs: string[] = [];

const makeRows = (count: number): CachedEmbedding[] =>
  Array.from({ length: count }, (_, index) => ({
    nodeId: `node-${index}`,
    chunkIndex: 0,
    startLine: index + 1,
    endLine: index + 1,
    embedding: [index, index + 0.25, index + 0.5, index + 0.75],
    contentHash: `hash-${index}`,
  }));

const makePath = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-embedding-snapshot-'));
  tempDirs.push(dir);
  return path.join(dir, 'snapshot.jsonl');
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('bounded embedding preservation snapshot', () => {
  it('streams 600 vectors through batches of at most 256', async () => {
    const snapshotPath = await makePath();
    const rows = makeRows(600);
    const source = { lastCommit: 'abc', indexedAt: '2026-07-20T00:00:00.000Z' };
    await createEmbeddingSnapshot(snapshotPath, source, async (emit) => {
      await emit(rows.slice(0, 256));
      await emit(rows.slice(256, 512));
      await emit(rows.slice(512));
    });

    await expect(validateEmbeddingSnapshot(snapshotPath, source, 600)).resolves.toMatchObject({
      count: 600,
      dimensions: 4,
    });
    const batchSizes: number[] = [];
    const restored: CachedEmbedding[] = [];
    await readEmbeddingSnapshot(snapshotPath, source, async (batch) => {
      batchSizes.push(batch.length);
      restored.push(...batch);
    });
    expect(batchSizes).toEqual([256, 256, 88]);
    expect(restored).toHaveLength(600);
    expect(restored[599]).toMatchObject({ nodeId: 'node-599', contentHash: 'hash-599' });
    expect(restored[599].embedding).toEqual(rows[599].embedding);
  });

  it('writes each embedding identity once when the producer repeats rows across batches', async () => {
    const snapshotPath = await makePath();
    const rows = makeRows(300);
    const source = { lastCommit: 'abc', indexedAt: '2026-07-20T00:00:00.000Z' };

    await expect(
      createEmbeddingSnapshot(snapshotPath, source, async (emit) => {
        await emit(rows.slice(0, 256));
        await emit([rows[100], ...rows.slice(256)]);
      }),
    ).resolves.toMatchObject({ count: 300, dimensions: 4, duplicateRows: 1 });

    await expect(validateEmbeddingSnapshot(snapshotPath, source, 300)).resolves.toMatchObject({
      count: 300,
      dimensions: 4,
    });
    const restored: CachedEmbedding[] = [];
    await readEmbeddingSnapshot(snapshotPath, source, async (batch) => restored.push(...batch));
    expect(restored).toHaveLength(300);
    expect(restored.filter((row) => row.nodeId === 'node-100')).toHaveLength(1);
  });

  it('restores each identity once from a valid legacy snapshot with non-adjacent duplicates', async () => {
    const snapshotPath = await makePath();
    const source = { lastCommit: 'abc', indexedAt: '2026-07-20T00:00:00.000Z' };
    await createEmbeddingSnapshot(snapshotPath, source, async (emit) => emit(makeRows(3)));

    const lines = (await fs.readFile(snapshotPath, 'utf8')).trimEnd().split('\n');
    const footer = JSON.parse(lines.pop() ?? '{}') as Record<string, unknown>;
    const duplicate = JSON.parse(lines[0]) as Record<string, unknown>;
    duplicate.contentHash = 'conflicting-later-copy';
    const physicalRows = [...lines, JSON.stringify(duplicate)];
    footer.count = physicalRows.length;
    footer.sha256 = createHash('sha256')
      .update(physicalRows.map((line) => `${line}\n`).join(''))
      .digest('hex');
    await fs.writeFile(snapshotPath, `${physicalRows.join('\n')}\n${JSON.stringify(footer)}\n`);

    await expect(validateEmbeddingSnapshot(snapshotPath, source, 3)).resolves.toMatchObject({
      count: 3,
      dimensions: 4,
      duplicateRows: 1,
    });
    const restored: CachedEmbedding[] = [];
    await expect(
      readEmbeddingSnapshot(snapshotPath, source, async (batch) => restored.push(...batch), 3),
    ).resolves.toMatchObject({ count: 3, dimensions: 4, duplicateRows: 1 });
    expect(restored).toHaveLength(3);
    expect(restored.find((row) => row.nodeId === 'node-0')?.contentHash).toBe('hash-0');
  });

  it('rejects tampering before invoking the restore callback', async () => {
    const snapshotPath = await makePath();
    const source = { lastCommit: 'abc', indexedAt: '2026-07-20T00:00:00.000Z' };
    await createEmbeddingSnapshot(snapshotPath, source, async (emit) => emit(makeRows(3)));
    const raw = await fs.readFile(snapshotPath, 'utf8');
    await fs.writeFile(snapshotPath, raw.replace('node-1', 'node-x'));
    const onBatch = vi.fn();

    await expect(validateEmbeddingSnapshot(snapshotPath, source)).resolves.toBeUndefined();
    await expect(readEmbeddingSnapshot(snapshotPath, source, onBatch)).rejects.toThrow(
      'failed validation',
    );
    expect(onBatch).not.toHaveBeenCalled();
  });

  it('rejects malformed base64 before invoking any restore batch', async () => {
    const snapshotPath = await makePath();
    const source = { lastCommit: 'abc', indexedAt: '2026-07-20T00:00:00.000Z' };
    const rows = makeRows(257);
    await createEmbeddingSnapshot(snapshotPath, source, async (emit) => {
      await emit(rows.slice(0, 256));
      await emit(rows.slice(256));
    });

    const lines = (await fs.readFile(snapshotPath, 'utf8')).trimEnd().split('\n');
    const footer = JSON.parse(lines.pop() ?? '{}') as Record<string, unknown>;
    const malformed = JSON.parse(lines[256]) as Record<string, unknown>;
    const encoded = String(malformed.embeddingBase64);
    malformed.embeddingBase64 = `${encoded.slice(0, 5)}!${encoded.slice(6)}`;
    lines[256] = JSON.stringify(malformed);
    footer.sha256 = createHash('sha256')
      .update(lines.map((line) => `${line}\n`).join(''))
      .digest('hex');
    await fs.writeFile(snapshotPath, `${lines.join('\n')}\n${JSON.stringify(footer)}\n`);
    const onBatch = vi.fn();

    await expect(validateEmbeddingSnapshot(snapshotPath, source, 257)).resolves.toBeUndefined();
    await expect(readEmbeddingSnapshot(snapshotPath, source, onBatch, 257)).rejects.toThrow(
      'failed validation',
    );
    expect(onBatch).not.toHaveBeenCalled();
  });

  it.each([
    [
      'missing nodeId',
      (row: Record<string, unknown>) => {
        delete row.nodeId;
      },
    ],
    [
      'non-integer chunkIndex',
      (row: Record<string, unknown>) => {
        row.chunkIndex = 'zero';
      },
    ],
  ])('rejects %s before invoking any restore batch', async (_name, corruptIdentity) => {
    const snapshotPath = await makePath();
    const source = { lastCommit: 'abc', indexedAt: '2026-07-20T00:00:00.000Z' };
    const rows = makeRows(257);
    await createEmbeddingSnapshot(snapshotPath, source, async (emit) => {
      await emit(rows.slice(0, 256));
      await emit(rows.slice(256));
    });

    const lines = (await fs.readFile(snapshotPath, 'utf8')).trimEnd().split('\n');
    const footer = JSON.parse(lines.pop() ?? '{}') as Record<string, unknown>;
    const malformed = JSON.parse(lines[256]) as Record<string, unknown>;
    corruptIdentity(malformed);
    lines[256] = JSON.stringify(malformed);
    footer.sha256 = createHash('sha256')
      .update(lines.map((line) => `${line}\n`).join(''))
      .digest('hex');
    await fs.writeFile(snapshotPath, `${lines.join('\n')}\n${JSON.stringify(footer)}\n`);
    const onBatch = vi.fn();

    await expect(validateEmbeddingSnapshot(snapshotPath, source, 257)).resolves.toBeUndefined();
    await expect(readEmbeddingSnapshot(snapshotPath, source, onBatch, 257)).rejects.toThrow(
      'failed validation',
    );
    expect(onBatch).not.toHaveBeenCalled();
  });

  it('binds a reusable snapshot to its source generation', async () => {
    const snapshotPath = await makePath();
    const source = { lastCommit: 'abc', indexedAt: '2026-07-20T00:00:00.000Z' };
    await createEmbeddingSnapshot(snapshotPath, source, async (emit) => emit(makeRows(1)));

    await expect(
      validateEmbeddingSnapshot(snapshotPath, { ...source, lastCommit: 'different' }),
    ).resolves.toBeUndefined();
  });

  it('keeps checkpoint-resume snapshots valid across metadata timestamp rewrites', async () => {
    const snapshotPath = await makePath();
    const source = { lastCommit: 'abc', indexedAt: '2026-07-22T00:00:00.000Z' };
    await createEmbeddingSnapshot(snapshotPath, source, async (emit) => emit(makeRows(1)));

    const checkpointMetadata = { lastCommit: 'abc', indexedAt: '2026-07-22T01:23:45.000Z' };
    const resumeSource = {
      lastCommit: checkpointMetadata.lastCommit,
      indexedAt: undefined,
    };
    await expect(validateEmbeddingSnapshot(snapshotPath, resumeSource)).resolves.toBeUndefined();
    await expect(
      validateEmbeddingSnapshot(snapshotPath, resumeSource, undefined, {
        allowSourceIndexedAtDriftForCheckpointResume: true,
      }),
    ).resolves.toMatchObject({ count: 1, dimensions: 4 });

    const restored: CachedEmbedding[] = [];
    await readEmbeddingSnapshot(
      snapshotPath,
      resumeSource,
      async (batch) => restored.push(...batch),
      undefined,
      { allowSourceIndexedAtDriftForCheckpointResume: true },
    );
    expect(restored).toHaveLength(1);
  });

  it('rejects a producer batch above the 256-vector cap and removes its temp file', async () => {
    const snapshotPath = await makePath();
    await expect(
      createEmbeddingSnapshot(snapshotPath, {}, async (emit) => emit(makeRows(257))),
    ).rejects.toThrow('exceeds 256 vectors');
    await expect(fs.access(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (await fs.readdir(path.dirname(snapshotPath))).filter((name) => name.includes('.tmp-')),
    ).toEqual([]);
  });
});
