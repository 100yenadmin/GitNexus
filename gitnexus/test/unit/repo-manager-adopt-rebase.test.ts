import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';

const fsCtx = vi.hoisted(() => ({
  rmMock: vi.fn(),
  realRm: null as ((...args: unknown[]) => Promise<unknown>) | null,
}));
function callRealRm(...args: unknown[]): Promise<unknown> {
  if (!fsCtx.realRm) throw new Error('real fs.rm is not initialized');
  return fsCtx.realRm(...args);
}

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const realFs = actual.default;
  fsCtx.realRm = realFs.rm.bind(realFs);
  fsCtx.rmMock.mockImplementation(callRealRm);
  return {
    default: new Proxy(realFs, {
      get(target, prop) {
        if (prop === 'rm') return fsCtx.rmMock;
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }),
  };
});

import fs from 'fs/promises';
import {
  adoptFlatBranchLabel,
  canonicalizePath,
  getStoragePaths,
  listRegisteredRepos,
  registerRepo,
  saveMeta,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';

describe('adoptFlatBranchLabel registry rebase (#267)', () => {
  let home: string;
  let repo: string;
  let otherRepo: string;
  let savedHome: string | undefined;

  const metaFor = (branch: string, lastCommit: string): RepoMeta => ({
    repoPath: '',
    lastCommit,
    indexedAt: `2026-08-24T00:00:0${lastCommit.length}.000Z`,
    branch,
    stats: { files: lastCommit.length, nodes: 1 },
  });

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-adopt-rebase-home-'));
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-adopt-rebase-repo-'));
    otherRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-adopt-rebase-other-'));
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = home;
    fsCtx.rmMock.mockReset();
    fsCtx.rmMock.mockImplementation(callRealRm);
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    fsCtx.rmMock.mockImplementation(callRealRm);
    await Promise.all([home, repo, otherRepo].map((dir) => callRealRm(dir, { recursive: true })));
  });

  it('rebases under lock while recursive deletion is held outside it', async () => {
    await registerRepo(repo, metaFor('main', 'old-primary'), {
      name: 'old-alias',
    });
    await registerRepo(repo, metaFor('feature/x', 'old-branch'), {
      branch: 'feature/x',
    });
    await registerRepo(repo, metaFor('feature/y', 'old-sibling'), {
      branch: 'feature/y',
    });
    await registerRepo(otherRepo, metaFor('main', 'other'));
    const { metaPath } = getStoragePaths(repo, 'feature/x');
    await saveMeta(path.dirname(metaPath), metaFor('feature/x', 'old-branch'));

    const beforeOther = (await listRegisteredRepos()).find(
      (entry) => canonicalizePath(entry.path) === canonicalizePath(otherRepo),
    );
    let releaseRm = () => undefined;
    let announceRm = () => undefined;
    const rmHeld = new Promise<void>((resolve) => (releaseRm = resolve));
    const rmStarted = new Promise<void>((resolve) => (announceRm = resolve));
    fsCtx.rmMock.mockImplementationOnce(async (...args) => {
      announceRm();
      await rmHeld;
      return callRealRm(...args);
    });

    const adoption = adoptFlatBranchLabel(repo, 'feature/x');
    await rmStarted;
    const concurrent = (async () => {
      await registerRepo(repo, metaFor('main', 'fresh-primary'), {
        name: 'fresh-alias',
      });
      await registerRepo(repo, metaFor('feature/x', 'fresh-branch'), {
        branch: 'feature/x',
      });
      await registerRepo(repo, metaFor('feature/y', 'fresh-sibling'), {
        branch: 'feature/y',
      });
    })();
    await concurrent; // would deadlock/time out if recursive deletion held the registry lock
    releaseRm();
    await adoption;

    const entries = await listRegisteredRepos();
    const adopted = entries.find(
      (entry) => canonicalizePath(entry.path) === canonicalizePath(repo),
    );
    expect(adopted).toMatchObject({
      name: 'fresh-alias',
      branch: 'feature/x',
      lastCommit: 'fresh-primary',
    });
    expect(adopted?.branches).toEqual([
      expect.objectContaining({
        branch: 'feature/x',
        lastCommit: 'fresh-branch',
      }),
      expect.objectContaining({
        branch: 'feature/y',
        lastCommit: 'fresh-sibling',
      }),
    ]);
    expect(
      entries.find((entry) => canonicalizePath(entry.path) === canonicalizePath(otherRepo)),
    ).toEqual(beforeOther);
    await expect(fs.access(path.dirname(metaPath))).rejects.toThrow();
  });
});
