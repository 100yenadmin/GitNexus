import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../src/core/search/bm25-index.js', () => ({
  searchFTSFromLbug: vi.fn().mockResolvedValue({ results: [], ftsAvailable: true }),
}));
vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn().mockResolvedValue([]),
  getEmbeddingDims: vi.fn().mockReturnValue(384),
}));

import { dbIdentityChanged, statDbIdentity } from '../../src/core/lbug/pool-adapter.js';

describe('read-pool file identity', () => {
  let directory: string;
  let dbPath: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-pool-fresh-'));
    dbPath = path.join(directory, 'lbug');
    await fs.writeFile(dbPath, 'v1-index-bytes', 'utf8');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('keeps an unchanged or temporarily missing identity on the current handle', async () => {
    const before = await statDbIdentity(dbPath);
    expect(dbIdentityChanged(before, await statDbIdentity(dbPath))).toBe(false);
    await fs.rm(dbPath);
    expect(dbIdentityChanged(before, await statDbIdentity(dbPath))).toBe(false);
  });

  it('detects replacement and in-place growth', async () => {
    const beforeReplace = await statDbIdentity(dbPath);
    await fs.rm(dbPath);
    await fs.writeFile(dbPath, 'v2-rebuilt-index-with-different-length', 'utf8');
    const afterReplace = await statDbIdentity(dbPath);
    expect(dbIdentityChanged(beforeReplace, afterReplace)).toBe(true);

    await fs.appendFile(dbPath, '-more');
    expect(dbIdentityChanged(afterReplace, await statDbIdentity(dbPath))).toBe(true);
  });

  it('compares all identity fields', () => {
    const base = { ino: 10, mtimeMs: 1000, size: 500 };
    expect(dbIdentityChanged(base, { ...base })).toBe(false);
    expect(dbIdentityChanged(base, { ...base, ino: 11 })).toBe(true);
    expect(dbIdentityChanged(base, { ...base, mtimeMs: 1001 })).toBe(true);
    expect(dbIdentityChanged(base, { ...base, size: 501 })).toBe(true);
  });
});
