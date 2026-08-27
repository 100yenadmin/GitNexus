import fs from 'fs/promises';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { createTempDir } from '../helpers/test-db.js';
import {
  removeEmbeddingTableRebuildMarker,
  validateEmbeddingTableRebuildMarker,
  writeEmbeddingTableRebuildMarker,
} from '../../src/core/embeddings/rebuild-marker.js';

describe('embedding table rebuild marker', () => {
  const source = { lastCommit: 'abc123', indexedAt: '2026-07-22T00:00:00.000Z' };
  const snapshot = { count: 42, dimensions: 2048, identitySha256: 'fixture-identity' };

  it('distinguishes an untouched table from a matching durable rebuild', async () => {
    const temp = await createTempDir('gitnexus-embedding-rebuild-marker-');
    const markerPath = path.join(temp.dbPath, 'embedding-table-rebuild.json');
    try {
      await expect(validateEmbeddingTableRebuildMarker(markerPath, source, snapshot)).resolves.toBe(
        false,
      );
      await writeEmbeddingTableRebuildMarker(markerPath, source, snapshot);
      await expect(validateEmbeddingTableRebuildMarker(markerPath, source, snapshot)).resolves.toBe(
        true,
      );
      await removeEmbeddingTableRebuildMarker(markerPath);
      await expect(validateEmbeddingTableRebuildMarker(markerPath, source, snapshot)).resolves.toBe(
        false,
      );
    } finally {
      await temp.cleanup();
    }
  });

  it('refuses a marker without the exact durable snapshot identity', async () => {
    const temp = await createTempDir('gitnexus-embedding-rebuild-marker-mismatch-');
    const markerPath = path.join(temp.dbPath, 'embedding-table-rebuild.json');
    try {
      await writeEmbeddingTableRebuildMarker(markerPath, source, snapshot);
      await expect(
        validateEmbeddingTableRebuildMarker(markerPath, source, undefined),
      ).rejects.toThrow('without a valid preservation snapshot');
      await expect(
        validateEmbeddingTableRebuildMarker(markerPath, source, { ...snapshot, count: 41 }),
      ).rejects.toThrow('does not match');
      await fs.writeFile(markerPath, '{broken', 'utf8');
      await expect(
        validateEmbeddingTableRebuildMarker(markerPath, source, snapshot),
      ).rejects.toThrow('malformed');
    } finally {
      await temp.cleanup();
    }
  });

  it('keeps a durable marker when directory fsync is unsupported', async () => {
    const temp = await createTempDir('gitnexus-embedding-rebuild-marker-fsync-');
    const markerPath = path.join(temp.dbPath, 'embedding-table-rebuild.json');
    const originalOpen = fs.open.bind(fs);
    const open = vi
      .spyOn(fs, 'open')
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        if (String(args[0]) === path.dirname(markerPath)) {
          return {
            sync: async () => {
              const error = new Error('directory fsync is unsupported') as NodeJS.ErrnoException;
              error.code = 'EINVAL';
              throw error;
            },
            close: async () => {},
          } as Awaited<ReturnType<typeof fs.open>>;
        }
        return originalOpen(...args);
      });
    try {
      await expect(writeEmbeddingTableRebuildMarker(markerPath, source, snapshot)).resolves.toBe(
        undefined,
      );
      await expect(validateEmbeddingTableRebuildMarker(markerPath, source, snapshot)).resolves.toBe(
        true,
      );
    } finally {
      open.mockRestore();
      await temp.cleanup();
    }
  });
});
