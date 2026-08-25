/**
 * Fast-path restamp failure modes (#2364 review F3, test gaps 4 and 7).
 * Separate from run-analyze.test.ts, which stays pure-real: these scenarios
 * need a delegating vi.mock of repo-manager (vi.spyOn cannot intercept ESM
 * namespace exports) to make adoptFlatBranchLabel / saveMeta fail on demand.
 *
 * Once-mock starvation hazard: the delegating mock intercepts EVERY
 * repo-manager call in the process, including this file's own fixture setup
 * (saveMeta seeds metas) — arm mockRejectedValueOnce only AFTER setup,
 * immediately before the runFullAnalysis call under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

type RepoManagerModule = typeof import('../../src/storage/repo-manager.js');

const rmCtx = vi.hoisted(() => ({
  adoptMock: vi.fn(),
  saveMetaMock: vi.fn(),
  realAdopt: null as RepoManagerModule['adoptFlatBranchLabel'] | null,
  realSaveMeta: null as RepoManagerModule['saveMeta'] | null,
}));

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<RepoManagerModule>();
  rmCtx.realAdopt = actual.adoptFlatBranchLabel;
  rmCtx.realSaveMeta = actual.saveMeta;
  rmCtx.adoptMock.mockImplementation(actual.adoptFlatBranchLabel);
  rmCtx.saveMetaMock.mockImplementation(actual.saveMeta);
  return {
    ...actual,
    adoptFlatBranchLabel: rmCtx.adoptMock,
    saveMeta: rmCtx.saveMetaMock,
  };
});

import {
  getStoragePaths,
  listRegisteredRepos,
  registerRepo,
  loadMeta,
  INCREMENTAL_SCHEMA_VERSION,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { createTempDir } from '../helpers/test-db.js';
import { seedEmbeddingsForFiles } from '../helpers/embedding-seed.js';

describe('fast-path restamp failure modes (#2364 F3)', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let tmpRepo: Awaited<ReturnType<typeof createTempDir>>;
  let savedGitnexusHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-adopt-failure-home-');
    tmpRepo = await createTempDir('gitnexus-adopt-failure-repo-');
    savedGitnexusHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    rmCtx.adoptMock.mockReset();
    rmCtx.saveMetaMock.mockReset();
    rmCtx.adoptMock.mockImplementation(
      (...args: Parameters<RepoManagerModule['adoptFlatBranchLabel']>) => rmCtx.realAdopt!(...args),
    );
    rmCtx.saveMetaMock.mockImplementation((...args: Parameters<RepoManagerModule['saveMeta']>) =>
      rmCtx.realSaveMeta!(...args),
    );
  });

  afterEach(async () => {
    if (savedGitnexusHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedGitnexusHome;
    await tmpHome.cleanup();
    await tmpRepo.cleanup();
  });

  /** git repo on feature/x at one commit, flat meta labeled main, pinned feature/x sub-index, registered. */
  const seedFlippedWorkspace = async (): Promise<{
    flatStorage: string;
    branchMetaDir: string;
  }> => {
    execSync('git init', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
    execSync('git -c user.name=t -c user.email=t@t commit --allow-empty -m init', {
      cwd: tmpRepo.dbPath,
      stdio: 'pipe',
    });
    execSync('git branch -M main', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
    execSync('git checkout -b feature/x', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
    const commit = execSync('git rev-parse HEAD', {
      cwd: tmpRepo.dbPath,
      encoding: 'utf-8',
    }).trim();
    const metaFor = (branch: string): RepoMeta => ({
      repoPath: tmpRepo.dbPath,
      lastCommit: commit,
      indexedAt: new Date().toISOString(),
      branch,
      schemaVersion: INCREMENTAL_SCHEMA_VERSION,
    });
    const flat = getStoragePaths(tmpRepo.dbPath);
    await rmCtx.realSaveMeta!(flat.storagePath, metaFor('main'));
    const { initLbug, closeLbug } = await import('../../src/core/lbug/lbug-adapter.js');
    await initLbug(flat.lbugPath);
    await closeLbug();
    const branch = getStoragePaths(tmpRepo.dbPath, 'feature/x');
    await rmCtx.realSaveMeta!(path.dirname(branch.metaPath), metaFor('feature/x'));
    await registerRepo(tmpRepo.dbPath, metaFor('main'));
    await registerRepo(tmpRepo.dbPath, metaFor('feature/x'), { branch: 'feature/x' });
    return { flatStorage: flat.storagePath, branchMetaDir: path.dirname(branch.metaPath) };
  };

  it('a failed adopt keeps the retry guard true and the next run self-heals (gap 4)', async () => {
    const { flatStorage, branchMetaDir } = await seedFlippedWorkspace();
    const logs: string[] = [];

    rmCtx.adoptMock.mockRejectedValueOnce(new Error('mock adopt failure'));
    const first = await runFullAnalysis(tmpRepo.dbPath, {}, { onLog: (m) => logs.push(m) });

    expect(first.alreadyUpToDate).toBe(true);
    expect(logs.some((m) => m.includes('could not restamp the workspace branch label'))).toBe(true);
    // saveMeta runs AFTER adopt, so the failed sync left the guard untouched…
    const stale = await loadMeta(flatStorage);
    expect(stale?.branch).toBe('main');
    await expect(fs.access(branchMetaDir)).resolves.toBeUndefined();

    // …and the next same-commit run retries and completes the whole sync.
    const second = await runFullAnalysis(tmpRepo.dbPath, {}, {});
    expect(second.alreadyUpToDate).toBe(true);
    const healed = await loadMeta(flatStorage);
    expect(healed?.branch).toBe('feature/x');
    await expect(fs.access(branchMetaDir)).rejects.toThrow();
  });

  it('adopt is invoked before the meta restamp on a successful flip', async () => {
    const { flatStorage } = await seedFlippedWorkspace();
    rmCtx.adoptMock.mockClear();
    rmCtx.saveMetaMock.mockClear();

    const result = await runFullAnalysis(tmpRepo.dbPath, {}, {});

    expect(result.alreadyUpToDate).toBe(true);
    expect(rmCtx.adoptMock).toHaveBeenCalledTimes(1);
    expect(rmCtx.saveMetaMock).toHaveBeenCalledTimes(1);
    expect(rmCtx.adoptMock.mock.invocationCallOrder[0]).toBeLessThan(
      rmCtx.saveMetaMock.mock.invocationCallOrder[0],
    );
    const meta = await loadMeta(flatStorage);
    expect(meta?.branch).toBe('feature/x');
  });

  it.each(['PRIMARY_DRIFT_RECONCILED', 'NOT_ADOPTED'] as const)(
    '%s retains the prior branch and retry protection',
    async (outcome) => {
      const { flatStorage, branchMetaDir } = await seedFlippedWorkspace();
      const logs: string[] = [];
      rmCtx.adoptMock.mockResolvedValueOnce(outcome);
      rmCtx.saveMetaMock.mockClear();

      const first = await runFullAnalysis(tmpRepo.dbPath, {}, { onLog: (m) => logs.push(m) });

      expect(first.alreadyUpToDate).toBe(true);
      expect(rmCtx.saveMetaMock).not.toHaveBeenCalled();
      expect((await loadMeta(flatStorage))?.branch).toBe('main');
      expect(logs.some((m) => m.includes(outcome) && m.includes('retry protection'))).toBe(true);
      await expect(fs.access(branchMetaDir)).resolves.toBeUndefined();

      const retry = await runFullAnalysis(tmpRepo.dbPath, {}, {});
      expect(retry.alreadyUpToDate).toBe(true);
      expect((await loadMeta(flatStorage))?.branch).toBe('feature/x');
      await expect(fs.access(branchMetaDir)).rejects.toThrow();
    },
  );

  it.each(['EROFS', 'EACCES', 'EPERM'] as const)(
    '"Already up to date" still succeeds when the restamp hits %s (#1549, gap 7)',
    async (code) => {
      const { flatStorage } = await seedFlippedWorkspace();
      const logs: string[] = [];

      rmCtx.saveMetaMock.mockRejectedValueOnce(Object.assign(new Error('mock ro'), { code }));
      const result = await runFullAnalysis(tmpRepo.dbPath, {}, { onLog: (m) => logs.push(m) });

      expect(result.alreadyUpToDate).toBe(true);
      expect(logs.some((m) => m.includes('read-only') && m.includes('#1549'))).toBe(true);
      // The stamp never landed, so the guard stays true for the next run.
      const meta = await loadMeta(flatStorage);
      expect(meta?.branch).toBe('main');
    },
  );

  it('reconciles the registry when checkout returns to the prior branch after restamp failure', async () => {
    const { flatStorage } = await seedFlippedWorkspace();
    rmCtx.saveMetaMock.mockRejectedValueOnce(Object.assign(new Error('mock ro'), { code: 'EIO' }));

    const first = await runFullAnalysis(tmpRepo.dbPath, {}, {});

    expect(first.alreadyUpToDate).toBe(true);
    expect((await loadMeta(flatStorage))?.branch).toBe('main');
    expect(
      (await listRegisteredRepos()).find((entry) => entry.path === tmpRepo.dbPath)?.branch,
    ).toBe('feature/x');

    execSync('git checkout main', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
    rmCtx.adoptMock.mockClear();
    rmCtx.saveMetaMock.mockClear();

    const retry = await runFullAnalysis(tmpRepo.dbPath, {}, {});

    expect(retry.alreadyUpToDate).toBe(true);
    expect(rmCtx.adoptMock).toHaveBeenCalledWith(tmpRepo.dbPath, 'main');
    expect(rmCtx.saveMetaMock).not.toHaveBeenCalled();
    expect((await loadMeta(flatStorage))?.branch).toBe('main');
    expect(
      (await listRegisteredRepos()).find((entry) => entry.path === tmpRepo.dbPath)?.branch,
    ).toBe('main');
  });

  it.each(['EROFS', 'EACCES', 'EPERM'] as const)(
    'verified count remains usable when its metadata restamp hits %s',
    async (code) => {
      await fs.writeFile(path.join(tmpRepo.dbPath, 'index.ts'), 'export function value() {}\n');
      execSync('git init && git add index.ts', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      execSync('git -c user.name=t -c user.email=t@t commit -m init', {
        cwd: tmpRepo.dbPath,
        stdio: 'pipe',
      });
      await runFullAnalysis(
        tmpRepo.dbPath,
        { skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {} },
      );
      await seedEmbeddingsForFiles(tmpRepo.dbPath, ['index.ts'], 1);
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      const meta = await loadMeta(storagePath);
      if (!meta) throw new Error('expected metadata');
      await rmCtx.realSaveMeta!(storagePath, {
        ...meta,
        stats: { ...meta.stats, embeddings: 0 },
      });
      rmCtx.saveMetaMock.mockRejectedValueOnce(Object.assign(new Error('mock ro'), { code }));
      const logs: string[] = [];

      const result = await runFullAnalysis(tmpRepo.dbPath, {}, { onLog: (m) => logs.push(m) });

      expect(result).toMatchObject({ alreadyUpToDate: true, stats: { embeddings: 1 } });
      expect(logs.some((m) => m.includes('embedding count') && m.includes('read-only'))).toBe(true);
      expect((await loadMeta(storagePath))?.stats?.embeddings).toBe(0);
    },
  );
});
