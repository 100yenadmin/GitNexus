/**
 * Regression test for listRegisteredRepos({ validate: true }) bare catch bug.
 *
 * BEFORE FIX: bare catch {} dropped entries on ANY fs.access error (EIO, EAGAIN,
 * EACCES, etc.) and persisted the pruned list → registry wiped to [].
 *
 * AFTER FIX: only prune on ENOENT/ENOTDIR (index genuinely gone). Transient I/O
 * errors keep the entry alive.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import { registerRepo, listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockMeta: any = {
  repoPath: '',
  lastCommit: 'abc1234',
  indexedAt: '2026-06-09T12:00:00.000Z',
  stats: { files: 1, nodes: 1 },
};

/**
 * Read the persisted registry straight off disk so tests can assert what was
 * actually written — the original bug was about *persisting* the wrong list,
 * not just returning it. The registry lives at $GITNEXUS_HOME/registry.json
 * (repo-manager getGlobalDir → getRegistryPath); readRegistry/writeRegistry
 * use fs.readFile/fs.writeFile, NOT fs.access, so the fs.access mocks below
 * never interfere with this read-back.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readRegistryFromDisk = async (): Promise<any[]> => {
  const raw = await fs.readFile(
    path.join(process.env.GITNEXUS_HOME as string, 'registry.json'),
    'utf8',
  );
  return JSON.parse(raw);
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('listRegisteredRepos({ validate: true }) — transient error safety (PR #2124)', () => {
  let tmpHome: { dbPath: string; cleanup: () => Promise<void> };
  let tmpRepo: { dbPath: string; cleanup: () => Promise<void> };
  let savedGitnexusHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-transient-home-');
    tmpRepo = await createTempDir('gitnexus-transient-repo-');
    savedGitnexusHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedGitnexusHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedGitnexusHome;
    await tmpRepo.cleanup();
    await tmpHome.cleanup();
  });

  it('ENOENT prunes the entry (index genuinely removed)', async () => {
    await registerRepo(tmpRepo.dbPath, mockMeta);

    // registerRepo writes the registry entry but doesn't create .gitnexus/meta.json.
    // That's done by analyze. Create it so the entry passes validation initially.
    const metaPath = path.join(tmpRepo.dbPath, '.gitnexus', 'meta.json');
    await fs.mkdir(path.dirname(metaPath), { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify(mockMeta));

    const before = await listRegisteredRepos({ validate: true });
    expect(before).toHaveLength(1);

    // Delete meta.json to simulate genuinely removed index
    await fs.unlink(metaPath);

    const after = await listRegisteredRepos({ validate: true });
    expect(after).toHaveLength(0);
    // The prune must be persisted — writeRegistry([]) ran.
    expect(await readRegistryFromDisk()).toHaveLength(0);
  });

  it('ENOTDIR prunes the entry (structural removal)', async () => {
    await registerRepo(tmpRepo.dbPath, mockMeta);
    const before = await listRegisteredRepos();
    expect(before).toHaveLength(1);

    // Replace .gitnexus dir with a regular file — fs.access(path/meta.json)
    // throws ENOTDIR because .gitnexus is now a file, not a directory
    const dotGitnexus = path.join(tmpRepo.dbPath, '.gitnexus');
    await fs.rm(dotGitnexus, { recursive: true, force: true });
    await fs.writeFile(dotGitnexus, 'not-a-dir');

    const after = await listRegisteredRepos({ validate: true });
    expect(after).toHaveLength(0);
  });

  it('EACCES keeps the entry (transient permission error)', async () => {
    await registerRepo(tmpRepo.dbPath, mockMeta);
    const before = await listRegisteredRepos();
    expect(before).toHaveLength(1);

    // Mock fs.access to throw EACCES — simulates NFS hiccup or temp permission
    const originalAccess = fs.access;
    vi.spyOn(fs, 'access').mockImplementation(async (p, mode) => {
      const pStr = typeof p === 'string' ? p : p.toString();
      if (pStr.includes('.gitnexus') && pStr.includes('meta.json')) {
        const err = new Error('permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return (originalAccess as any).call(fs, p, mode);
    });

    const after = await listRegisteredRepos({ validate: true });
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe(before[0].name);
    // Keep path must NOT rewrite the registry — on-disk file is unchanged.
    const onDisk = await readRegistryFromDisk();
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].name).toBe(before[0].name);
  });

  it('EIO keeps the entry (transient I/O error)', async () => {
    await registerRepo(tmpRepo.dbPath, mockMeta);
    const before = await listRegisteredRepos();
    expect(before).toHaveLength(1);

    const originalAccess = fs.access;
    vi.spyOn(fs, 'access').mockImplementation(async (p, mode) => {
      const pStr = typeof p === 'string' ? p : p.toString();
      if (pStr.includes('.gitnexus') && pStr.includes('meta.json')) {
        const err = new Error('input/output error') as NodeJS.ErrnoException;
        err.code = 'EIO';
        throw err;
      }
      return (originalAccess as any).call(fs, p, mode);
    });

    const after = await listRegisteredRepos({ validate: true });
    expect(after).toHaveLength(1);
    expect(await readRegistryFromDisk()).toHaveLength(1);
  });

  it('EAGAIN keeps the entry (resource temporarily unavailable)', async () => {
    await registerRepo(tmpRepo.dbPath, mockMeta);
    const before = await listRegisteredRepos();
    expect(before).toHaveLength(1);

    const originalAccess = fs.access;
    vi.spyOn(fs, 'access').mockImplementation(async (p, mode) => {
      const pStr = typeof p === 'string' ? p : p.toString();
      if (pStr.includes('.gitnexus') && pStr.includes('meta.json')) {
        const err = new Error('resource temporarily unavailable') as NodeJS.ErrnoException;
        err.code = 'EAGAIN';
        throw err;
      }
      return (originalAccess as any).call(fs, p, mode);
    });

    const after = await listRegisteredRepos({ validate: true });
    expect(after).toHaveLength(1);
    expect(await readRegistryFromDisk()).toHaveLength(1);
  });

  it('EBUSY keeps the entry (device/resource busy)', async () => {
    await registerRepo(tmpRepo.dbPath, mockMeta);
    const before = await listRegisteredRepos();
    expect(before).toHaveLength(1);

    const originalAccess = fs.access;
    vi.spyOn(fs, 'access').mockImplementation(async (p, mode) => {
      const pStr = typeof p === 'string' ? p : p.toString();
      if (pStr.includes('.gitnexus') && pStr.includes('meta.json')) {
        const err = new Error('resource busy') as NodeJS.ErrnoException;
        err.code = 'EBUSY';
        throw err;
      }
      return (originalAccess as any).call(fs, p, mode);
    });

    const after = await listRegisteredRepos({ validate: true });
    expect(after).toHaveLength(1);
    expect(await readRegistryFromDisk()).toHaveLength(1);
  });

  it.each(['EACCES', 'EIO', 'EBUSY'])(
    '%s from gitnexus.json keeps the entry even when legacy meta.json is ENOENT',
    async (newMetadataCode) => {
      await registerRepo(tmpRepo.dbPath, mockMeta);
      const before = await listRegisteredRepos();
      expect(before).toHaveLength(1);

      const newMetadataPath = path.join(tmpRepo.dbPath, '.gitnexus', 'gitnexus.json');
      const legacyMetadataPath = path.join(tmpRepo.dbPath, '.gitnexus', 'meta.json');

      const originalAccess = fs.access;
      vi.spyOn(fs, 'access').mockImplementation(async (p, mode) => {
        const pStr = typeof p === 'string' ? p : p.toString();

        if (pStr === newMetadataPath) {
          const err = new Error(newMetadataCode) as NodeJS.ErrnoException;
          err.code = newMetadataCode;
          throw err;
        }

        if (pStr === legacyMetadataPath) {
          const err = new Error('no such file') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }

        return (originalAccess as any).call(fs, p, mode);
      });

      const after = await listRegisteredRepos({ validate: true });
      expect(after).toHaveLength(1);
      expect(after[0].name).toBe(before[0].name);

      const onDisk = await readRegistryFromDisk();
      expect(onDisk).toHaveLength(1);
      expect(onDisk[0].name).toBe(before[0].name);
    },
  );

  it.each(['EACCES', 'EIO', 'EBUSY'])(
    '%s from legacy meta.json keeps the entry when gitnexus.json is ENOENT',
    async (legacyMetadataCode) => {
      await registerRepo(tmpRepo.dbPath, mockMeta);
      const before = await listRegisteredRepos();
      expect(before).toHaveLength(1);

      const newMetadataPath = path.join(tmpRepo.dbPath, '.gitnexus', 'gitnexus.json');
      const legacyMetadataPath = path.join(tmpRepo.dbPath, '.gitnexus', 'meta.json');

      const originalAccess = fs.access;
      vi.spyOn(fs, 'access').mockImplementation(async (p, mode) => {
        const pStr = typeof p === 'string' ? p : p.toString();

        if (pStr === newMetadataPath) {
          const err = new Error('no such file') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }

        if (pStr === legacyMetadataPath) {
          const err = new Error(legacyMetadataCode) as NodeJS.ErrnoException;
          err.code = legacyMetadataCode;
          throw err;
        }

        return (originalAccess as any).call(fs, p, mode);
      });

      const after = await listRegisteredRepos({ validate: true });
      expect(after).toHaveLength(1);
      expect(after[0].name).toBe(before[0].name);

      const onDisk = await readRegistryFromDisk();
      expect(onDisk).toHaveLength(1);
      expect(onDisk[0].name).toBe(before[0].name);
    },
  );

  it('mixed batch persists only the survivor (ENOENT pruned, EIO kept)', async () => {
    // Two registered repos: one whose index is genuinely gone (ENOENT) and one
    // that hits a transient I/O error (EIO) in the SAME validation call. This is
    // the only path that persists a non-empty surviving SUBSET — exactly where
    // an off-by-one would write the wrong list to disk.
    const tmpRepoB = await createTempDir('gitnexus-transient-repo-b-');
    try {
      const nameA = await registerRepo(tmpRepo.dbPath, mockMeta);
      const nameB = await registerRepo(tmpRepoB.dbPath, mockMeta);

      const before = await listRegisteredRepos();
      expect(before).toHaveLength(2);

      // Branch on each repo's distinct temp-dir segment — both meta.json paths
      // contain `.gitnexus`/`meta.json`, so matching those shared substrings
      // alone would mis-route. repo A → ENOENT (prune), repo B → EIO (keep).
      const originalAccess = fs.access;
      vi.spyOn(fs, 'access').mockImplementation(async (p, mode) => {
        const pStr = typeof p === 'string' ? p : p.toString();
        if (pStr.includes('meta.json') && pStr.includes(tmpRepo.dbPath)) {
          const err = new Error('no such file') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        if (pStr.includes('meta.json') && pStr.includes(tmpRepoB.dbPath)) {
          const err = new Error('input/output error') as NodeJS.ErrnoException;
          err.code = 'EIO';
          throw err;
        }
        return (originalAccess as any).call(fs, p, mode);
      });

      const after = await listRegisteredRepos({ validate: true });
      // Return value: only the EIO survivor (repo B).
      expect(after).toHaveLength(1);
      expect(after[0].name).toBe(nameB);
      expect(after.some((e) => e.name === nameA)).toBe(false);

      // On-disk: the surviving subset was persisted correctly — exactly repo B,
      // not [] (over-prune) and not both (no-op).
      const onDisk = await readRegistryFromDisk();
      expect(onDisk).toHaveLength(1);
      expect(onDisk[0].name).toBe(nameB);
      expect(onDisk.some((e) => e.name === nameA)).toBe(false);
    } finally {
      await tmpRepoB.cleanup();
    }
  });

  it('rebases pruning so a concurrent refresh survives while unchanged missing entries are removed', async () => {
    const missingRepo = await createTempDir('gitnexus-prune-missing-');
    const presentRepo = await createTempDir('gitnexus-prune-present-');
    try {
      const refreshedName = await registerRepo(tmpRepo.dbPath, mockMeta);
      const missingName = await registerRepo(missingRepo.dbPath, mockMeta);
      const presentName = await registerRepo(presentRepo.dbPath, mockMeta);
      const presentMetaPath = path.join(presentRepo.dbPath, '.gitnexus', 'meta.json');
      await fs.mkdir(path.dirname(presentMetaPath), { recursive: true });
      await fs.writeFile(presentMetaPath, JSON.stringify(mockMeta));

      const releaseProbe = deferred();
      const probeStarted = deferred();
      const refreshedMetadataPath = path.join(tmpRepo.dbPath, '.gitnexus', 'gitnexus.json');
      const originalAccess = fs.access;
      vi.spyOn(fs, 'access').mockImplementation(async (p, mode) => {
        const pStr = typeof p === 'string' ? p : p.toString();
        if (pStr === refreshedMetadataPath) {
          probeStarted.resolve();
          await releaseProbe.promise;
        }
        return (originalAccess as any).call(fs, p, mode);
      });

      const validation = listRegisteredRepos({ validate: true });
      await probeStarted.promise;
      await registerRepo(tmpRepo.dbPath, {
        ...mockMeta,
        lastCommit: 'fresh-owner',
        indexedAt: '2026-08-25T16:30:00.000Z',
      });
      releaseProbe.resolve();

      const returned = await validation;
      const persisted = await readRegistryFromDisk();
      expect(returned).toEqual(persisted);
      expect(returned.map((entry) => entry.name).sort()).toEqual(
        [presentName, refreshedName].sort(),
      );
      expect(returned.some((entry) => entry.name === missingName)).toBe(false);
      expect(returned.find((entry) => entry.name === refreshedName)).toMatchObject({
        lastCommit: 'fresh-owner',
        indexedAt: '2026-08-25T16:30:00.000Z',
      });
    } finally {
      await presentRepo.cleanup();
      await missingRepo.cleanup();
    }
  });

  it('throws on a transient locked registry reread without returning a false empty list', async () => {
    await registerRepo(tmpRepo.dbPath, mockMeta);
    const before = await readRegistryFromDisk();
    const registryPath = path.join(process.env.GITNEXUS_HOME as string, 'registry.json');
    const originalReadFile = fs.readFile;
    let registryReads = 0;
    const readSpy = vi.spyOn(fs, 'readFile').mockImplementation(async (p, options) => {
      const pStr = typeof p === 'string' ? p : p.toString();
      if (pStr === registryPath && ++registryReads === 2) {
        const err = new Error('input/output error') as NodeJS.ErrnoException;
        err.code = 'EIO';
        throw err;
      }
      return (originalReadFile as any).call(fs, p, options);
    });

    await expect(listRegisteredRepos({ validate: true })).rejects.toMatchObject({ code: 'EIO' });
    readSpy.mockRestore();
    expect(await readRegistryFromDisk()).toEqual(before);
  });

  it('preserves a structurally identical re-registration completed after the initial probe', async () => {
    const missingRepo = await createTempDir('gitnexus-prune-identical-missing-');
    try {
      const refreshedName = await registerRepo(tmpRepo.dbPath, mockMeta);
      const missingName = await registerRepo(missingRepo.dbPath, mockMeta);
      const refreshedMetadataPath = path.join(tmpRepo.dbPath, '.gitnexus', 'gitnexus.json');
      const releaseProbe = deferred();
      const probeStarted = deferred();
      const originalAccess = fs.access;
      let heldInitialProbe = false;
      vi.spyOn(fs, 'access').mockImplementation(async (p, mode) => {
        const pStr = typeof p === 'string' ? p : p.toString();
        if (pStr === refreshedMetadataPath && !heldInitialProbe) {
          heldInitialProbe = true;
          probeStarted.resolve();
          await releaseProbe.promise;
          const err = new Error('no such file') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        return (originalAccess as any).call(fs, p, mode);
      });

      const validation = listRegisteredRepos({ validate: true });
      await probeStarted.promise;
      await fs.mkdir(path.dirname(refreshedMetadataPath), { recursive: true });
      await fs.writeFile(refreshedMetadataPath, JSON.stringify(mockMeta));
      await registerRepo(tmpRepo.dbPath, mockMeta);
      releaseProbe.resolve();

      const returned = await validation;
      expect(returned).toEqual(await readRegistryFromDisk());
      expect(returned.some((entry) => entry.name === refreshedName)).toBe(true);
      expect(returned.some((entry) => entry.name === missingName)).toBe(false);
    } finally {
      await missingRepo.cleanup();
    }
  });
});
