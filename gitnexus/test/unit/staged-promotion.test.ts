import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  getStagedAnalyzePaths,
  prepareStagedWorkspace,
  promoteStagedGeneration,
  withAnalyzeOwnershipLock,
  type PromotionBoundary,
  type RepositorySourceIdentity,
} from '../../src/core/staged-promotion.js';
import { loadMeta, saveMeta, type RepoMeta } from '../../src/storage/repo-manager.js';

const tempDirs: string[] = [];
const sourceRepo: RepositorySourceIdentity = { head: 'source-head', branch: 'main' };

const makeMeta = (generation: string): RepoMeta => ({
  repoPath: '/repo',
  lastCommit: generation,
  indexedAt: `2026-07-20T00:00:0${generation === 'old' ? '0' : '1'}.000Z`,
  stats: { nodes: generation === 'old' ? 1 : 2, edges: 0 },
});

const setup = async (withCanonical = true) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-'));
  tempDirs.push(root);
  const canonicalMetaDir = path.join(root, '.gitnexus');
  const canonicalLbugPath = path.join(canonicalMetaDir, 'lbug');
  await fs.mkdir(canonicalMetaDir, { recursive: true });
  const oldMeta = withCanonical ? makeMeta('old') : null;
  if (oldMeta) {
    await fs.writeFile(canonicalLbugPath, 'old-generation');
    await saveMeta(canonicalMetaDir, oldMeta);
  }
  const paths = getStagedAnalyzePaths(canonicalLbugPath, canonicalMetaDir);
  await prepareStagedWorkspace(paths, oldMeta, sourceRepo);
  await fs.writeFile(paths.stagedLbugPath, 'new-generation');
  const newMeta = makeMeta('new');
  await saveMeta(paths.stagedMetaDir, newMeta);
  return { paths, canonicalLbugPath, canonicalMetaDir, newMeta, sourceRepo };
};

const exists = async (filePath: string): Promise<boolean> =>
  fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('staged promotion journal', () => {
  for (const boundary of [
    'prepared',
    'old-backed-up',
    'new-installed',
    'metadata/registry-committed',
  ] as const) {
    it(`recovers after a crash at ${boundary}`, async () => {
      const { paths, canonicalLbugPath, canonicalMetaDir } = await setup();
      let commits = 0;
      const commit = async (meta: RepoMeta): Promise<string> => {
        commits++;
        await saveMeta(canonicalMetaDir, meta);
        return 'repo';
      };

      await expect(
        promoteStagedGeneration(paths, commit, {
          afterBoundary: (reached: PromotionBoundary) => {
            if (reached === boundary) throw new Error(`crash:${boundary}`);
          },
        }),
      ).rejects.toThrow(`crash:${boundary}`);

      expect((await exists(canonicalLbugPath)) || (await exists(paths.backupLbugPath))).toBe(true);

      await promoteStagedGeneration(paths, commit);
      expect(await fs.readFile(canonicalLbugPath, 'utf8')).toBe('new-generation');
      expect((await loadMeta(canonicalMetaDir))?.lastCommit).toBe('new');
      expect(await exists(paths.backupLbugPath)).toBe(false);
      expect(await exists(paths.journalPath)).toBe(false);
      expect(commits).toBe(1);
    });
  }

  it('recovers a canonical-to-backup rename that happened before the journal advanced', async () => {
    const { paths, canonicalLbugPath, canonicalMetaDir } = await setup();
    const commit = async (meta: RepoMeta) => {
      await saveMeta(canonicalMetaDir, meta);
      return 'repo';
    };
    await expect(
      promoteStagedGeneration(paths, commit, {
        afterBoundary: (boundary) => {
          if (boundary === 'prepared') throw new Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    await fs.rename(canonicalLbugPath, paths.backupLbugPath);

    await promoteStagedGeneration(paths, commit);
    expect(await fs.readFile(canonicalLbugPath, 'utf8')).toBe('new-generation');
  });

  it('recovers a staged-to-canonical rename that happened before the journal advanced', async () => {
    const { paths, canonicalLbugPath, canonicalMetaDir } = await setup();
    const commit = async (meta: RepoMeta) => {
      await saveMeta(canonicalMetaDir, meta);
      return 'repo';
    };
    await expect(
      promoteStagedGeneration(paths, commit, {
        afterBoundary: (boundary) => {
          if (boundary === 'old-backed-up') throw new Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    await fs.rename(paths.stagedLbugPath, canonicalLbugPath);

    await promoteStagedGeneration(paths, commit);
    expect(await fs.readFile(canonicalLbugPath, 'utf8')).toBe('new-generation');
  });

  it('preserves recovery for a journal written before source guards were added', async () => {
    const { paths, canonicalLbugPath, canonicalMetaDir } = await setup();
    const commit = async (meta: RepoMeta) => {
      await saveMeta(canonicalMetaDir, meta);
      return 'repo';
    };
    await expect(
      promoteStagedGeneration(paths, commit, {
        afterBoundary: (boundary) => {
          if (boundary === 'old-backed-up') throw new Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    const legacyJournal = JSON.parse(await fs.readFile(paths.journalPath, 'utf8')) as Record<
      string,
      unknown
    >;
    delete legacyJournal.sourceMetaFiles;
    delete legacyJournal.sourceRepo;
    await fs.writeFile(paths.journalPath, `${JSON.stringify(legacyJournal)}\n`);

    await promoteStagedGeneration(paths, commit);
    expect(await fs.readFile(canonicalLbugPath, 'utf8')).toBe('new-generation');
  });

  it('retries metadata and registration after metadata was saved but registration failed', async () => {
    const { paths, canonicalLbugPath, canonicalMetaDir } = await setup();
    let attempts = 0;
    const commit = async (meta: RepoMeta): Promise<string> => {
      attempts++;
      await saveMeta(canonicalMetaDir, meta);
      if (attempts === 1) throw new Error('register failed');
      return 'repo';
    };

    await expect(promoteStagedGeneration(paths, commit)).rejects.toThrow('register failed');
    expect(
      (JSON.parse(await fs.readFile(paths.journalPath, 'utf8')) as { state: string }).state,
    ).toBe('new-installed');
    expect((await loadMeta(canonicalMetaDir))?.lastCommit).toBe('new');
    expect(await exists(paths.backupLbugPath)).toBe(true);

    await expect(promoteStagedGeneration(paths, commit)).resolves.toMatchObject({
      projectName: 'repo',
      recovered: true,
    });
    expect(attempts).toBe(2);
    expect(await fs.readFile(canonicalLbugPath, 'utf8')).toBe('new-generation');
    expect((await loadMeta(canonicalMetaDir))?.lastCommit).toBe('new');
    expect(await exists(paths.backupLbugPath)).toBe(false);
    expect(await exists(paths.journalPath)).toBe(false);
  });

  for (const installedDbState of ['missing', 'wrong'] as const) {
    it(`does not restore the old DB over staged metadata when the installed DB is ${installedDbState}`, async () => {
      const { paths, canonicalLbugPath, canonicalMetaDir } = await setup();
      let attempts = 0;
      const commit = async (meta: RepoMeta): Promise<string> => {
        attempts++;
        await saveMeta(canonicalMetaDir, meta);
        throw new Error('register failed');
      };

      await expect(promoteStagedGeneration(paths, commit)).rejects.toThrow('register failed');
      if (installedDbState === 'missing') {
        await fs.rm(canonicalLbugPath);
      } else {
        await fs.writeFile(canonicalLbugPath, 'wrong-installed-generation');
      }

      await expect(promoteStagedGeneration(paths, commit)).rejects.toThrow(
        'canonical database identity changed',
      );
      expect(attempts).toBe(1);
      expect((await loadMeta(canonicalMetaDir))?.lastCommit).toBe('new');
      expect(await fs.readFile(paths.backupLbugPath, 'utf8')).toBe('old-generation');
      expect(await exists(paths.journalPath)).toBe(true);
      if (installedDbState === 'missing') {
        expect(await exists(canonicalLbugPath)).toBe(false);
      } else {
        expect(await fs.readFile(canonicalLbugPath, 'utf8')).toBe('wrong-installed-generation');
      }
    });
  }

  it('finishes registration after source HEAD moves once the staged DB and metadata are canonical', async () => {
    const { paths, canonicalLbugPath, canonicalMetaDir } = await setup();
    let attempts = 0;
    const commit = async (meta: RepoMeta): Promise<string> => {
      attempts++;
      await saveMeta(canonicalMetaDir, meta);
      if (attempts === 1) throw new Error('register failed');
      return 'repo';
    };

    await expect(
      promoteStagedGeneration(paths, commit, {
        readRepositoryIdentity: () => sourceRepo,
      }),
    ).rejects.toThrow('register failed');

    await expect(
      promoteStagedGeneration(paths, commit, {
        readRepositoryIdentity: () => ({ head: 'later-head', branch: 'other' }),
      }),
    ).resolves.toMatchObject({ projectName: 'repo', recovered: true });
    expect(attempts).toBe(2);
    expect(await fs.readFile(canonicalLbugPath, 'utf8')).toBe('new-generation');
    expect((await loadMeta(canonicalMetaDir))?.lastCommit).toBe('new');
    expect(await exists(paths.backupLbugPath)).toBe(false);
    expect(await exists(paths.journalPath)).toBe(false);
  });

  it('refuses recovery when metadata differs from both source and staged generations', async () => {
    const { paths, canonicalLbugPath, canonicalMetaDir } = await setup();
    let attempts = 0;
    const commit = async (meta: RepoMeta): Promise<string> => {
      attempts++;
      await saveMeta(canonicalMetaDir, meta);
      throw new Error('register failed');
    };

    await expect(promoteStagedGeneration(paths, commit)).rejects.toThrow('register failed');
    await saveMeta(canonicalMetaDir, {
      ...makeMeta('new'),
      stats: { nodes: 99, edges: 99 },
    });

    await expect(promoteStagedGeneration(paths, commit)).rejects.toThrow(
      'canonical metadata changed',
    );
    expect(attempts).toBe(1);
    expect(await fs.readFile(canonicalLbugPath, 'utf8')).toBe('new-generation');
    expect(await exists(paths.backupLbugPath)).toBe(true);
    expect(await exists(paths.journalPath)).toBe(true);
  });

  it('restores the old generation when the staged DB disappears after backup', async () => {
    const { paths, canonicalLbugPath, canonicalMetaDir } = await setup();
    await expect(
      promoteStagedGeneration(
        paths,
        async (meta) => {
          await saveMeta(canonicalMetaDir, meta);
          return 'repo';
        },
        {
          afterBoundary: (boundary) => {
            if (boundary === 'old-backed-up') throw new Error('crash');
          },
        },
      ),
    ).rejects.toThrow('crash');
    await fs.rm(paths.stagedLbugPath, { force: true });

    await expect(promoteStagedGeneration(paths, async () => 'repo')).rejects.toThrow(
      'restored the canonical backup',
    );
    expect(await fs.readFile(canonicalLbugPath, 'utf8')).toBe('old-generation');
  });

  it('promotes the first generation without inventing an old backup', async () => {
    const { paths, canonicalLbugPath, canonicalMetaDir } = await setup(false);
    await promoteStagedGeneration(paths, async (meta) => {
      await saveMeta(canonicalMetaDir, meta);
      return 'repo';
    });

    expect(await fs.readFile(canonicalLbugPath, 'utf8')).toBe('new-generation');
    expect(await exists(paths.backupLbugPath)).toBe(false);
  });

  it('reuses an interrupted stage only while canonical source identity is unchanged', async () => {
    const { paths, canonicalLbugPath } = await setup();
    await fs.writeFile(paths.stagedLbugPath, 'partial-new-generation');
    const oldMeta = makeMeta('old');
    await expect(prepareStagedWorkspace(paths, oldMeta, sourceRepo)).resolves.toMatchObject({
      resumed: true,
    });
    expect(await fs.readFile(paths.stagedLbugPath, 'utf8')).toBe('partial-new-generation');

    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.writeFile(canonicalLbugPath, 'externally-changed-canonical');
    await expect(prepareStagedWorkspace(paths, oldMeta, sourceRepo)).resolves.toMatchObject({
      resumed: false,
    });
    expect(await fs.readFile(paths.stagedLbugPath, 'utf8')).toBe('externally-changed-canonical');
  });

  it('refuses to copy a canonical DB with unresolved WAL state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-wal-'));
    tempDirs.push(root);
    const metaDir = path.join(root, '.gitnexus');
    const lbugPath = path.join(metaDir, 'lbug');
    await fs.mkdir(metaDir, { recursive: true });
    await fs.writeFile(lbugPath, 'canonical');
    await fs.writeFile(`${lbugPath}.wal`, 'pending');
    const meta = makeMeta('old');
    await saveMeta(metaDir, meta);

    await expect(
      prepareStagedWorkspace(getStagedAnalyzePaths(lbugPath, metaDir), meta),
    ).rejects.toThrow('unresolved LadybugDB sidecars');
    expect(await fs.readFile(lbugPath, 'utf8')).toBe('canonical');
  });

  it('refuses promotion when canonical DB or metadata changed after prepare', async () => {
    const { paths, canonicalLbugPath, canonicalMetaDir } = await setup();
    await fs.writeFile(canonicalLbugPath, 'newer-canonical-generation');
    await saveMeta(canonicalMetaDir, {
      ...makeMeta('old'),
      indexedAt: '2026-07-20T00:00:09.000Z',
    });

    await expect(promoteStagedGeneration(paths, async () => 'repo')).rejects.toThrow(
      'canonical metadata changed',
    );
    expect(await fs.readFile(canonicalLbugPath, 'utf8')).toBe('newer-canonical-generation');
    expect((await loadMeta(canonicalMetaDir))?.indexedAt).toBe('2026-07-20T00:00:09.000Z');
  });

  it('refuses promotion when only the canonical DB identity changed after prepare', async () => {
    const { paths, canonicalLbugPath } = await setup();
    await fs.writeFile(canonicalLbugPath, 'newer-canonical-generation');

    await expect(promoteStagedGeneration(paths, async () => 'repo')).rejects.toThrow(
      'canonical database identity changed',
    );
    expect(await fs.readFile(canonicalLbugPath, 'utf8')).toBe('newer-canonical-generation');
  });

  it('refuses promotion when metadata files were replaced with the same semantic values', async () => {
    const { paths, canonicalMetaDir } = await setup();
    await saveMeta(canonicalMetaDir, makeMeta('old'));

    await expect(promoteStagedGeneration(paths, async () => 'repo')).rejects.toThrow(
      'metadata file identity changed',
    );
  });

  it('refuses promotion when repository HEAD or branch changed after prepare', async () => {
    const { paths, canonicalLbugPath } = await setup();

    await expect(
      promoteStagedGeneration(paths, async () => 'repo', {
        readRepositoryIdentity: () => ({ head: 'new-head', branch: 'other' }),
      }),
    ).rejects.toThrow('repository HEAD or branch changed');
    expect(await fs.readFile(canonicalLbugPath, 'utf8')).toBe('old-generation');
  });

  it('recovers a first-generation crash after stage creation but before its manifest', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-first-intent-'));
    tempDirs.push(root);
    const metaDir = path.join(root, '.gitnexus');
    const paths = getStagedAnalyzePaths(path.join(metaDir, 'lbug'), metaDir);

    await expect(
      prepareStagedWorkspace(paths, null, sourceRepo, {
        afterStagePrepared: () => {
          throw new Error('crash-before-manifest');
        },
      }),
    ).rejects.toThrow('crash-before-manifest');
    expect(await exists(paths.stageIntentPath)).toBe(true);
    expect(await exists(paths.stageManifestPath)).toBe(false);

    await expect(prepareStagedWorkspace(paths, null, sourceRepo)).resolves.toMatchObject({
      resumed: false,
    });
    expect(await exists(paths.stageManifestPath)).toBe(true);
    expect(await exists(paths.stageIntentPath)).toBe(false);
  });
});

describe('common analyze ownership lock', () => {
  it('refuses a concurrent ordinary or staged writer', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-'));
    tempDirs.push(root);
    let release!: () => void;
    const first = withAnalyzeOwnershipLock(
      root,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await vi.waitFor(async () => {
      await expect(fs.access(path.join(root, 'analyze-staged.lock'))).resolves.toBeUndefined();
    });

    await expect(withAnalyzeOwnershipLock(root, async () => undefined)).rejects.toThrow(
      'Another analyze is active',
    );
    release();
    await first;
  });

  it('reclaims a lock whose owner process is gone', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-'));
    tempDirs.push(root);
    await fs.writeFile(
      path.join(root, 'analyze-staged.lock'),
      `${JSON.stringify({
        schema: 'gitnexus.staged-analyze-lock/v1',
        pid: 2_147_483_647,
        nonce: 'dead-owner',
        startedAt: '2026-07-20T00:00:00.000Z',
      })}\n`,
    );

    await expect(withAnalyzeOwnershipLock(root, async () => 'ok')).resolves.toBe('ok');
    await expect(fs.access(path.join(root, 'analyze-staged.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('retains ownership after storage is detached without recreating absent storage', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stable-owner-'));
    tempDirs.push(parent);
    const repoRoot = path.join(parent, 'repo');
    const storagePath = path.join(repoRoot, '.gitnexus');
    const detachedPath = path.join(repoRoot, '.gitnexus.detached');
    await fs.mkdir(storagePath, { recursive: true });
    let markDetached!: () => void;
    const detached = new Promise<void>((resolve) => {
      markDetached = resolve;
    });
    let release!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const owner = withAnalyzeOwnershipLock(
      storagePath,
      async () => {
        await fs.rename(storagePath, detachedPath);
        markDetached();
        await releaseGate;
      },
      { repoRoot },
    );
    await detached;

    await expect(
      withAnalyzeOwnershipLock(storagePath, async () => undefined, {
        repoRoot,
        createStoragePath: false,
      }),
    ).rejects.toThrow('Another analyze is active');
    await expect(fs.access(storagePath)).rejects.toMatchObject({ code: 'ENOENT' });

    release();
    await owner;
    await expect(
      withAnalyzeOwnershipLock(storagePath, async () => 'released', {
        repoRoot,
        createStoragePath: false,
      }),
    ).resolves.toBe('released');
    await expect(fs.access(storagePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
