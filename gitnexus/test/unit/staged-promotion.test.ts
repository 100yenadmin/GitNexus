import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  AnalyzeOwnershipConflictError,
  attachAnalyzeOwnershipWorker,
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

const recoveryEntries = async (lockPath: string): Promise<string[]> => {
  const basename = path.basename(lockPath);
  return (await fs.readdir(path.dirname(lockPath))).filter(
    (entry) =>
      entry.startsWith(`${basename}.reclaim.`) || entry.startsWith(`${basename}.lease-source.`),
  );
};

const writeDeadAnalyzeLock = (lockPath: string): Promise<void> =>
  fs.writeFile(
    lockPath,
    `${JSON.stringify({
      schema: 'gitnexus.staged-analyze-lock/v1',
      pid: 2_147_483_647,
      nonce: 'dead-owner',
      startedAt: '2026-07-20T00:00:00.000Z',
    })}\n`,
  );

const deadRecoveryLeaseRecord = {
  schema: 'gitnexus.staged-analyze-lock/v1',
  pid: 2_147_483_646,
  nonce: 'deadca11',
  startedAt: '2026-07-20T00:00:02.000Z',
  processStartToken: 'deadbeefdeadbeefdeadbeef',
} as const;

const deadRecoveryClaimPath = (lockPath: string): string =>
  `${lockPath}.reclaim.${deadRecoveryLeaseRecord.pid}.` +
  `${deadRecoveryLeaseRecord.processStartToken}.${deadRecoveryLeaseRecord.nonce}`;

const deadRecoveryLeaseSourcePath = (lockPath: string): string =>
  `${lockPath}.lease-source.${deadRecoveryLeaseRecord.pid}.` +
  `${deadRecoveryLeaseRecord.processStartToken}.${deadRecoveryLeaseRecord.nonce}`;

const currentProcessStartToken = (): string => {
  let identity: string;
  if (process.platform === 'linux') {
    const stat = execFileSync('/bin/cat', [`/proc/${process.pid}/stat`], { encoding: 'utf8' });
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    identity = `linux:${fields[19]}`;
  } else if (process.platform === 'win32') {
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const script =
      `$p = Get-Process -Id ${process.pid} -ErrorAction Stop; ` +
      '[Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)';
    const start = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
    }).trim();
    identity = `win32:${start}`;
  } else {
    const start = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
    }).trim();
    identity = `${process.platform}:${start}`;
  }
  return createHash('sha256').update(identity).digest('hex').slice(0, 24);
};

const deadOwnershipPublicationSourcePath = (lockPath: string): string =>
  `${lockPath}.owner-source.${deadRecoveryLeaseRecord.pid}.${deadRecoveryLeaseRecord.nonce}`;

const publishDeadRecoveryLease = async (lockPath: string): Promise<void> => {
  const sourcePath = deadRecoveryLeaseSourcePath(lockPath);
  await fs.writeFile(sourcePath, `${JSON.stringify(deadRecoveryLeaseRecord)}\n`);
  await fs.link(sourcePath, `${lockPath}.reclaim`);
};

const publishDeadOwnershipLock = async (lockPath: string): Promise<void> => {
  const sourcePath = deadOwnershipPublicationSourcePath(lockPath);
  await fs.writeFile(sourcePath, `${JSON.stringify(deadRecoveryLeaseRecord)}\n`);
  await fs.link(sourcePath, lockPath);
};

const recoveryResidue = async (lockPath: string): Promise<string[]> => {
  const basename = path.basename(lockPath);
  return (await fs.readdir(path.dirname(lockPath))).filter(
    (entry) =>
      entry.startsWith(`${basename}.reclaim`) || entry.startsWith(`${basename}.lease-source`),
  );
};

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
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.chmod(dir, 0o700).catch(() => {});
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
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
  it('retries a transient failure while releasing the exact locally owned main lock', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-release-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'analyze-staged.lock');
    const originalRm = fs.rm.bind(fs);
    const rmSpy = vi.spyOn(fs, 'rm');
    let operationEntered = false;
    let failedOnce = false;

    rmSpy.mockImplementation(async (target, options) => {
      if (operationEntered && String(target) === lockPath && !failedOnce) {
        failedOnce = true;
        throw Object.assign(new Error('transient owned lock release failure'), { code: 'EPERM' });
      }
      return originalRm(target, options);
    });

    try {
      await expect(
        withAnalyzeOwnershipLock(root, async () => {
          operationEntered = true;
          return 'released';
        }),
      ).resolves.toBe('released');
      expect(failedOnce).toBe(true);
      await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await recoveryEntries(lockPath)).toEqual([]);
    } finally {
      rmSpy.mockRestore();
    }
  });

  it('preserves the operation failure when owned-lock release also exhausts its retries', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-dual-failure-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'analyze-staged.lock');
    const originalRm = fs.rm.bind(fs);
    const rmSpy = vi.spyOn(fs, 'rm');
    let operationEntered = false;
    let releaseAttempts = 0;

    rmSpy.mockImplementation(async (target, options) => {
      if (operationEntered && String(target) === lockPath) {
        releaseAttempts++;
        throw Object.assign(new Error('release retries exhausted'), { code: 'EPERM' });
      }
      return originalRm(target, options);
    });

    try {
      const failure = await withAnalyzeOwnershipLock(root, async () => {
        operationEntered = true;
        throw new Error('analysis failed first');
      }).catch((error) => error);

      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([
        expect.objectContaining({ message: 'analysis failed first' }),
        expect.objectContaining({ message: 'release retries exhausted' }),
      ]);
      expect((failure as Error).message).toMatch(/analysis failed first/);
      expect((failure as Error).message).toMatch(/release retries exhausted/);
      expect(releaseAttempts).toBe(3);
    } finally {
      rmSpy.mockRestore();
    }
  });

  it('retries a wrapped transient read failure while releasing the owned main lock', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-read-release-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'analyze-staged.lock');
    const originalReadFile = fs.readFile.bind(fs);
    const readSpy = vi.spyOn(fs, 'readFile');
    let operationEntered = false;
    let failedOnce = false;

    readSpy.mockImplementation(async (target, options) => {
      if (operationEntered && String(target) === lockPath && !failedOnce) {
        failedOnce = true;
        throw Object.assign(new Error('transient owned lock read failure'), { code: 'EBUSY' });
      }
      return originalReadFile(target, options);
    });

    try {
      await expect(
        withAnalyzeOwnershipLock(root, async () => {
          operationEntered = true;
          return 'released';
        }),
      ).resolves.toBe('released');
      expect(failedOnce).toBe(true);
      await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await recoveryEntries(lockPath)).toEqual([]);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('treats an owned lock removed with its storage as already released', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-removed-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'analyze-staged.lock');

    await expect(
      withAnalyzeOwnershipLock(root, async () => {
        await fs.rm(lockPath);
        return 'deleted';
      }),
    ).resolves.toBe('deleted');
  });

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
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(fs.access(path.join(root, 'analyze-staged.lock'))).resolves.toBeUndefined();

    await expect(withAnalyzeOwnershipLock(root, async () => undefined)).rejects.toThrow(
      'Another analyze is active',
    );
    release();
    await first;
  });

  it('reclaims a lock whose owner process is gone', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-'));
    tempDirs.push(root);
    await writeDeadAnalyzeLock(path.join(root, 'analyze-staged.lock'));

    await expect(withAnalyzeOwnershipLock(root, async () => 'ok')).resolves.toBe('ok');
    await expect(fs.access(path.join(root, 'analyze-staged.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.access(path.join(root, 'analyze-staged.lock.reclaim'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await recoveryEntries(path.join(root, 'analyze-staged.lock'))).toEqual([]);
  });

  it('reclaims a lock when a live pid belongs to a different process generation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-pid-reuse-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'analyze-staged.lock');
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({
        schema: 'gitnexus.staged-analyze-lock/v1',
        pid: process.pid,
        nonce: 'prior-process-generation',
        startedAt: '2026-07-20T00:00:00.000Z',
        processStartToken: '000000000000000000000000',
      })}\n`,
    );

    await expect(withAnalyzeOwnershipLock(root, async () => 'ok')).resolves.toBe('ok');
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await recoveryEntries(lockPath)).toEqual([]);
  });

  it('keeps a dead parent lease active while its attached worker generation lives', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-worker-live-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'analyze-staged.lock');
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({
        schema: 'gitnexus.staged-analyze-lock/v1',
        pid: 2_147_483_647,
        nonce: 'dead-parent',
        startedAt: '2026-07-20T00:00:00.000Z',
        attachedWorker: { pid: process.pid, processStartToken: currentProcessStartToken() },
      })}\n`,
    );

    await expect(withAnalyzeOwnershipLock(root, async () => undefined)).rejects.toThrow(
      'Another analyze is active',
    );
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({
        schema: 'gitnexus.staged-analyze-lock/v1',
        pid: 2_147_483_647,
        nonce: 'dead-parent',
        startedAt: '2026-07-20T00:00:00.000Z',
        attachedWorker: {
          pid: 2_147_483_646,
          processStartToken: 'deadbeefdeadbeefdeadbeef',
        },
      })}\n`,
    );
    await expect(withAnalyzeOwnershipLock(root, async () => 'reclaimed')).resolves.toBe(
      'reclaimed',
    );
  });

  it('publishes the attached worker before retaining and releasing the parent lease', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-worker-attach-'));
    tempDirs.push(parent);
    const repoRoot = path.join(parent, 'repo');
    const storagePath = path.join(repoRoot, '.gitnexus');
    const home = path.join(parent, 'home');
    vi.stubEnv('GITNEXUS_HOME', home);
    await fs.mkdir(storagePath, { recursive: true });
    let release!: () => void;
    const held = withAnalyzeOwnershipLock(
      storagePath,
      () => new Promise<void>((resolve) => (release = resolve)),
      { repoRoot },
    );
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));

    await attachAnalyzeOwnershipWorker(storagePath, repoRoot, process.pid);
    const lockEntries = await fs.readdir(path.join(home, 'locks'));
    const companion = path.join(home, 'locks', lockEntries[0]);
    const record = JSON.parse(await fs.readFile(companion, 'utf8')) as {
      attachedWorker?: { pid: number; processStartToken: string };
    };
    expect(record.attachedWorker).toMatchObject({
      pid: process.pid,
      processStartToken: expect.stringMatching(/^[0-9a-f]{24}$/),
    });

    await expect(
      withAnalyzeOwnershipLock(storagePath, async () => undefined, { repoRoot }),
    ).rejects.toThrow('Another analyze is active');
    release();
    await held;
    await expect(
      withAnalyzeOwnershipLock(storagePath, async () => 'released', { repoRoot }),
    ).resolves.toBe('released');
  });

  it('keeps a live legacy tokenless owner fail-closed and byte-identical', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-legacy-live-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'analyze-staged.lock');
    const original = `${JSON.stringify({
      schema: 'gitnexus.staged-analyze-lock/v1',
      pid: process.pid,
      nonce: 'legacy-live-owner',
      startedAt: '2026-07-20T00:00:00.000Z',
    })}\n`;
    await fs.writeFile(lockPath, original);

    await expect(withAnalyzeOwnershipLock(root, async () => undefined)).rejects.toThrow(
      'Another analyze is active',
    );
    await expect(fs.readFile(lockPath, 'utf8')).resolves.toBe(original);
    expect(await recoveryEntries(lockPath)).toEqual([]);
  });

  it('does not require process-start identity for an uncontended acquisition', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-uncontended-'));
    tempDirs.push(root);
    const readFileSpy = vi.spyOn(fs, 'readFile');

    if (process.platform === 'linux') {
      readFileSpy.mockRejectedValueOnce(
        Object.assign(new Error('process identity unavailable'), { code: 'EACCES' }),
      );
    }

    await expect(withAnalyzeOwnershipLock(root, async () => 'ok')).resolves.toBe('ok');
    await expect(fs.access(path.join(root, 'analyze-staged.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    if (process.platform === 'linux') {
      expect(
        readFileSpy.mock.calls.some(([target]) => String(target) === `/proc/${process.pid}/stat`),
      ).toBe(true);
    }
    readFileSpy.mockRestore();
  });

  it('admits exactly one contender when reclaiming the same stale lock', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-race-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'analyze-staged.lock');
    await writeDeadAnalyzeLock(lockPath);

    let release!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const contender = () =>
      withAnalyzeOwnershipLock(root, async () => {
        entered += 1;
        await releaseGate;
      });
    const attempts = [contender(), contender()];

    try {
      const firstSettled = await Promise.race(
        attempts.map((attempt) =>
          attempt.then(
            () => ({ status: 'fulfilled' as const }),
            (error: unknown) => ({ status: 'rejected' as const, error }),
          ),
        ),
      );
      expect(firstSettled.status).toBe('rejected');
      if (firstSettled.status === 'rejected') {
        expect(firstSettled.error).toBeInstanceOf(AnalyzeOwnershipConflictError);
      }
      await vi.waitFor(() => expect(entered).toBe(1));
    } finally {
      release();
    }

    const settled = await Promise.allSettled(attempts);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await recoveryEntries(lockPath)).toEqual([]);
  });

  it('does not clear an active reclaimer after its final identity check', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-paused-reclaim-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'analyze-staged.lock');
    await writeDeadAnalyzeLock(lockPath);

    let markPaused!: () => void;
    const paused = new Promise<void>((resolve) => {
      markPaused = resolve;
    });
    let resume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const originalRm = fs.rm.bind(fs);
    let pausedMainRemoval = false;
    const rmSpy = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (String(target) === lockPath && !pausedMainRemoval) {
        pausedMainRemoval = true;
        markPaused();
        await resumeGate;
      }
      return originalRm(target, options);
    });

    let entered = 0;
    const reclaimer = withAnalyzeOwnershipLock(root, async () => {
      entered += 1;
    });
    try {
      await paused;
      await expect(fs.open(`${lockPath}.reclaim`, 'wx', 0o600)).rejects.toMatchObject({
        code: 'EEXIST',
      });
      await expect(withAnalyzeOwnershipLock(root, async () => undefined)).rejects.toThrow(
        /recovery is active/i,
      );
      expect(entered).toBe(0);
    } finally {
      resume();
      rmSpy.mockRestore();
    }
    await reclaimer;
    expect(entered).toBe(1);
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(`${lockPath}.reclaim`)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await recoveryEntries(lockPath)).toEqual([]);
  });

  it('uses a timezone-independent claimant identity on macOS', async () => {
    if (process.platform !== 'darwin') return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-timezone-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'analyze-staged.lock');
    await writeDeadAnalyzeLock(lockPath);
    const startIdentity = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
    }).trim();
    const token = createHash('sha256').update(`darwin:${startIdentity}`).digest('hex').slice(0, 24);
    await fs.link(lockPath, `${lockPath}.reclaim.${process.pid}.${token}.deadca11`);
    await fs.rm(lockPath);
    vi.stubEnv('TZ', 'America/New_York');

    await expect(withAnalyzeOwnershipLock(root, async () => undefined)).rejects.toThrow(
      /recovery is active/i,
    );
  });

  it('recovers a dead hard-link claim left before stale-main removal', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-claim-before-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'analyze-staged.lock');
    await writeDeadAnalyzeLock(lockPath);
    await fs.link(lockPath, `${lockPath}.reclaim.2147483646.deadbeef.deadca11`);

    await expect(withAnalyzeOwnershipLock(root, async () => 'recovered')).resolves.toBe(
      'recovered',
    );
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await recoveryEntries(lockPath)).toEqual([]);
  });

  it('recovers a pre-unlink claim when both stale owner and claimant pids are reused', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-claim-reused-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'analyze-staged.lock');
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({
        schema: 'gitnexus.staged-analyze-lock/v1',
        pid: process.pid,
        nonce: 'stale-main-owner',
        startedAt: '2026-07-20T00:00:00.000Z',
        processStartToken: '000000000000000000000000',
      })}\n`,
    );
    await fs.link(lockPath, `${lockPath}.reclaim.${process.pid}.111111111111111111111111.deadca11`);

    await expect(withAnalyzeOwnershipLock(root, async () => 'recovered')).resolves.toBe(
      'recovered',
    );
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await recoveryEntries(lockPath)).toEqual([]);
  });

  it('recovers a dead hard-link claim left after stale-main removal', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-claim-after-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'analyze-staged.lock');
    await writeDeadAnalyzeLock(lockPath);
    await fs.link(lockPath, `${lockPath}.reclaim.2147483646.deadbeef.deadca11`);
    await fs.rm(lockPath);

    await expect(withAnalyzeOwnershipLock(root, async () => 'recovered')).resolves.toBe(
      'recovered',
    );
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await recoveryEntries(lockPath)).toEqual([]);
  });

  it('recovers an orphaned claim after its claimant PID is reused', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-claim-reused-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'analyze-staged.lock');
    await writeDeadAnalyzeLock(lockPath);
    await fs.link(lockPath, `${lockPath}.reclaim.${process.pid}.deadbeef.deadca11`);
    await fs.rm(lockPath);

    await expect(withAnalyzeOwnershipLock(root, async () => 'recovered')).resolves.toBe(
      'recovered',
    );
    expect(await recoveryEntries(lockPath)).toEqual([]);
  });

  it('fails closed while a legacy recovery marker exists', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-legacy-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'analyze-staged.lock');
    const markerPath = `${lockPath}.reclaim`;
    await fs.writeFile(markerPath, 'legacy-recovery');

    await expect(withAnalyzeOwnershipLock(root, async () => undefined)).rejects.toThrow(
      /legacy analyze recovery is active/i,
    );
    await expect(fs.readFile(markerPath, 'utf8')).resolves.toBe('legacy-recovery');
  });

  it('recovers a valid legacy marker whose owner process is gone', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-dead-legacy-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'analyze-staged.lock');
    await writeDeadAnalyzeLock(lockPath);
    await writeDeadAnalyzeLock(`${lockPath}.reclaim`);

    await expect(withAnalyzeOwnershipLock(root, async () => 'recovered')).resolves.toBe(
      'recovered',
    );
    expect(await recoveryResidue(lockPath)).toEqual([]);
  });

  it('recovers a crash before atomic lease publication', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-lease-source-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'analyze-staged.lock');
    await fs.writeFile(deadRecoveryLeaseSourcePath(lockPath), 'partial');

    await expect(withAnalyzeOwnershipLock(root, async () => 'recovered')).resolves.toBe(
      'recovered',
    );
    expect(await recoveryResidue(lockPath)).toEqual([]);
  });

  it('recovers a crash before atomic successor-lock publication', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-owner-source-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'analyze-staged.lock');
    await fs.writeFile(deadOwnershipPublicationSourcePath(lockPath), 'partial');

    await expect(withAnalyzeOwnershipLock(root, async () => 'recovered')).resolves.toBe(
      'recovered',
    );
    await expect(fs.access(deadOwnershipPublicationSourcePath(lockPath))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers a crash after atomic successor-lock publication', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-owner-published-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'analyze-staged.lock');
    await publishDeadOwnershipLock(lockPath);

    await expect(withAnalyzeOwnershipLock(root, async () => 'recovered')).resolves.toBe(
      'recovered',
    );
    await expect(fs.access(deadOwnershipPublicationSourcePath(lockPath))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    {
      phase: 'after atomic lease publication',
      setup: async (lockPath: string) => {
        await writeDeadAnalyzeLock(lockPath);
        await publishDeadRecoveryLease(lockPath);
      },
    },
    {
      phase: 'after stale-inode claim publication',
      setup: async (lockPath: string) => {
        await writeDeadAnalyzeLock(lockPath);
        await fs.link(lockPath, deadRecoveryClaimPath(lockPath));
        await publishDeadRecoveryLease(lockPath);
      },
    },
    {
      phase: 'after stale-main removal',
      setup: async (lockPath: string) => {
        await writeDeadAnalyzeLock(lockPath);
        await fs.link(lockPath, deadRecoveryClaimPath(lockPath));
        await fs.rm(lockPath);
        await publishDeadRecoveryLease(lockPath);
      },
    },
    {
      phase: 'after successor-lock durability',
      setup: async (lockPath: string) => {
        await fs.writeFile(lockPath, `${JSON.stringify(deadRecoveryLeaseRecord)}\n`);
        await publishDeadRecoveryLease(lockPath);
      },
    },
  ])('recovers a dead process-bound lease $phase', async ({ setup }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-dead-lease-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'analyze-staged.lock');
    await setup(lockPath);
    let entered = 0;

    await expect(
      withAnalyzeOwnershipLock(root, async () => {
        entered += 1;
        return 'recovered';
      }),
    ).resolves.toBe('recovered');
    expect(entered).toBe(1);
    expect(await recoveryResidue(lockPath)).toEqual([]);
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not unlink a replacement while two contenders clean a dead lease', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-cleanup-race-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'analyze-staged.lock');
    const markerPath = `${lockPath}.reclaim`;
    await writeDeadAnalyzeLock(lockPath);
    await publishDeadRecoveryLease(lockPath);

    let markPaused!: () => void;
    const paused = new Promise<void>((resolve) => {
      markPaused = resolve;
    });
    let resume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const originalRm = fs.rm.bind(fs);
    let pausedMarkerRemoval = false;
    const rmSpy = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (String(target) === markerPath && !pausedMarkerRemoval) {
        pausedMarkerRemoval = true;
        markPaused();
        await resumeGate;
      }
      return originalRm(target, options);
    });

    let entered = 0;
    const winner = withAnalyzeOwnershipLock(root, async () => {
      entered += 1;
    });
    try {
      await paused;
      await expect(withAnalyzeOwnershipLock(root, async () => undefined)).rejects.toThrow(
        /recovery cleanup is active/i,
      );
      expect(entered).toBe(0);
    } finally {
      resume();
      rmSpy.mockRestore();
    }

    await winner;
    expect(entered).toBe(1);
    expect(await recoveryResidue(lockPath)).toEqual([]);
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retries an exact locally owned cleanup claim after transient unlink failure', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-cleanup-retry-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'analyze-staged.lock');
    await writeDeadAnalyzeLock(lockPath);
    await publishDeadRecoveryLease(lockPath);

    const originalRm = fs.rm.bind(fs);
    let failedCleanupRemoval = false;
    const rmSpy = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (String(target).includes('.reclaim-cleanup.') && !failedCleanupRemoval) {
        failedCleanupRemoval = true;
        throw Object.assign(new Error('transient cleanup claim failure'), { code: 'EPERM' });
      }
      return originalRm(target, options);
    });
    try {
      await expect(withAnalyzeOwnershipLock(root, async () => undefined)).rejects.toThrow(
        /transient cleanup claim failure/i,
      );
    } finally {
      rmSpy.mockRestore();
    }

    await expect(withAnalyzeOwnershipLock(root, async () => 'retried')).resolves.toBe('retried');
    expect(await recoveryResidue(lockPath)).toEqual([]);
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns an ownership conflict when a cleanup marker vanishes before claim publication', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-cleanup-missing-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'analyze-staged.lock');
    const markerPath = `${lockPath}.reclaim`;
    await writeDeadAnalyzeLock(lockPath);
    await publishDeadRecoveryLease(lockPath);

    const originalLink = fs.link.bind(fs);
    let removedMarker = false;
    const linkSpy = vi.spyOn(fs, 'link').mockImplementation(async (source, destination) => {
      if (
        String(source) === markerPath &&
        String(destination).includes('.reclaim-cleanup.') &&
        !removedMarker
      ) {
        removedMarker = true;
        await fs.rm(markerPath);
      }
      return originalLink(source, destination);
    });
    try {
      const attempt = withAnalyzeOwnershipLock(root, async () => undefined);
      await expect(attempt).rejects.toBeInstanceOf(AnalyzeOwnershipConflictError);
      await expect(attempt).rejects.toThrow(/ownership changed before cleanup/i);
    } finally {
      linkSpy.mockRestore();
    }
  });

  it('retries lease-source cleanup after the marker was already released', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-source-retry-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'analyze-staged.lock');
    await writeDeadAnalyzeLock(lockPath);

    const originalRm = fs.rm.bind(fs);
    let failedSourceRemoval = false;
    const rmSpy = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (String(target).includes('.lease-source.') && !failedSourceRemoval) {
        failedSourceRemoval = true;
        throw Object.assign(new Error('transient source removal failure'), { code: 'EPERM' });
      }
      return originalRm(target, options);
    });
    try {
      await expect(withAnalyzeOwnershipLock(root, async () => undefined)).rejects.toThrow(
        /transient source removal failure/i,
      );
    } finally {
      rmSpy.mockRestore();
    }

    expect(await recoveryResidue(lockPath)).toEqual([]);
    await expect(withAnalyzeOwnershipLock(root, async () => 'retried')).resolves.toBe('retried');
    expect(await recoveryResidue(lockPath)).toEqual([]);
  });

  it('does not execute a PATH-shadowed process identity helper on macOS', async () => {
    if (process.platform !== 'darwin') return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-path-shadow-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'analyze-staged.lock');
    const fakeBin = path.join(root, 'bin');
    const sentinel = path.join(root, 'shadow-executed');
    await fs.mkdir(fakeBin);
    await fs.writeFile(
      path.join(fakeBin, 'ps'),
      `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\nprintf 'shadowed\\n'\n`,
      { mode: 0o755 },
    );
    await writeDeadAnalyzeLock(lockPath);
    const startIdentity = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
    }).trim();
    const token = createHash('sha256').update(`darwin:${startIdentity}`).digest('hex').slice(0, 24);
    await fs.link(lockPath, `${lockPath}.reclaim.${process.pid}.${token}.deadca11`);
    await fs.rm(lockPath);
    vi.stubEnv('PATH', fakeBin);

    await expect(withAnalyzeOwnershipLock(root, async () => undefined)).rejects.toThrow(
      /recovery is active/i,
    );
    await expect(fs.access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves mismatched live ownership when a dead recovery claim is ambiguous', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-claim-mismatch-'));
    tempDirs.push(root);
    const lockPath = path.join(root, 'analyze-staged.lock');
    const unrelated = path.join(root, 'unrelated-stale-lock');
    const liveOwner = {
      schema: 'gitnexus.staged-analyze-lock/v1',
      pid: process.pid,
      nonce: 'live-owner',
      startedAt: '2026-07-20T00:00:01.000Z',
    };
    await fs.writeFile(lockPath, `${JSON.stringify(liveOwner)}\n`);
    await writeDeadAnalyzeLock(unrelated);
    const claimPath = `${lockPath}.reclaim.2147483646.deadbeef.deadca11`;
    await fs.link(unrelated, claimPath);

    await expect(withAnalyzeOwnershipLock(root, async () => undefined)).rejects.toThrow(
      /does not match the current lock/i,
    );
    await expect(fs.readFile(lockPath, 'utf8')).resolves.toBe(`${JSON.stringify(liveOwner)}\n`);
    await expect(fs.access(claimPath)).resolves.toBeUndefined();
  });

  it('retains ownership after storage is detached without recreating absent storage', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stable-owner-'));
    tempDirs.push(parent);
    const repoRoot = path.join(parent, 'repo');
    const storagePath = path.join(repoRoot, '.gitnexus');
    const detachedPath = path.join(repoRoot, '.gitnexus.detached');
    const isolatedHome = path.join(parent, 'home');
    vi.stubEnv('GITNEXUS_HOME', isolatedHome);
    await fs.mkdir(isolatedHome, { recursive: true });
    await fs.mkdir(storagePath, { recursive: true });
    if (process.platform !== 'win32') await fs.chmod(parent, 0o555);
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
    const lockEntries = await fs.readdir(path.join(isolatedHome, 'locks'));
    expect(lockEntries).toHaveLength(1);
    expect(lockEntries[0]).toMatch(/^analyze-[0-9a-f]{32}\.lock$/);
    expect((await fs.readdir(parent)).sort()).toEqual(['home', 'repo']);

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
