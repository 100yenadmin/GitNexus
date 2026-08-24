import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';

const fsCtx = vi.hoisted(() => ({
  gate: null as { path: string; entered: () => void; release: Promise<void> } | null,
  lockAttempts: 0,
  realReadFile: null as ((...args: unknown[]) => Promise<unknown>) | null,
  realOpen: null as ((...args: unknown[]) => Promise<unknown>) | null,
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const fs = actual.default;
  fsCtx.realReadFile = fs.readFile.bind(fs);
  fsCtx.realOpen = fs.open.bind(fs);
  return {
    default: new Proxy(fs, {
      get(target, prop) {
        if (prop === 'readFile') {
          return async (...args: unknown[]) => {
            const gate = fsCtx.gate;
            if (gate && String(args[0]) === gate.path) {
              fsCtx.gate = null;
              gate.entered();
              await gate.release;
            }
            return fsCtx.realReadFile!(...args);
          };
        }
        if (prop === 'open') {
          return (...args: unknown[]) => {
            if (String(args[0]).endsWith('registry.json.lock')) fsCtx.lockAttempts++;
            return fsCtx.realOpen!(...args);
          };
        }
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
  getStoragePath,
  readRegistry,
  registerRepo,
  unregisterRepo,
  type RegistryEntry,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

describe('simple registry writers share the mutation lock (#266)', () => {
  let home: Awaited<ReturnType<typeof createTempDir>>;
  let repo: Awaited<ReturnType<typeof createTempDir>>;
  let savedHome: string | undefined;
  let registryPath: string;

  const owner = (): RegistryEntry => ({
    name: 'owner',
    path: repo.dbPath,
    storagePath: getStoragePath(repo.dbPath),
    indexedAt: '2026-08-23T00:00:00.000Z',
    lastCommit: 'old',
    branch: 'main',
    branches: [
      { branch: 'feature/x', indexedAt: 'old-x', lastCommit: 'x' },
      { branch: 'feature/y', indexedAt: 'old-y', lastCommit: 'y' },
    ],
  });
  const unrelated = (): RegistryEntry => ({
    name: 'other',
    path: '/virtual/other',
    storagePath: '/virtual/other/.gitnexus',
    indexedAt: 'unchanged',
    lastCommit: 'other',
  });
  const meta = (): RepoMeta => ({
    repoPath: repo.dbPath,
    indexedAt: '2026-08-24T00:00:00.000Z',
    lastCommit: 'new',
    branch: 'main',
  });

  beforeEach(async () => {
    home = await createTempDir('gitnexus-writer-lock-home-');
    repo = await createTempDir('gitnexus-writer-lock-repo-');
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = home.dbPath;
    registryPath = path.join(home.dbPath, 'registry.json');
    fsCtx.lockAttempts = 0;
  });

  afterEach(async () => {
    fsCtx.gate = null;
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await home.cleanup();
    await repo.cleanup();
  });

  const pauseNextRegistryRead = () => {
    const entered = deferred();
    const release = deferred();
    fsCtx.gate = { path: registryPath, entered: entered.resolve, release: release.promise };
    return { entered: entered.promise, release: release.resolve };
  };

  const waitForContentionOrCommit = async () => {
    await vi.waitFor(async () => {
      const entries = JSON.parse(await fs.readFile(registryPath, 'utf8')) as RegistryEntry[];
      expect(fsCtx.lockAttempts >= 2 || entries[0]?.lastCommit === 'new').toBe(true);
    });
  };

  it('prevents expected-owner registration from resurrecting an unregistered owner', async () => {
    const expected = owner();
    const other = unrelated();
    await fs.writeFile(registryPath, JSON.stringify([expected, other]));
    const gate = pauseNextRegistryRead();
    const removing = unregisterRepo(repo.dbPath);
    await gate.entered;
    const registering = registerRepo(repo.dbPath, meta(), { expectedOwner: expected });
    await waitForContentionOrCommit();
    gate.release();

    await removing;
    await expect(registering).rejects.toThrow(
      'GitNexus: expected registry owner changed during locked commit',
    );
    expect(await readRegistry()).toEqual([other]);
    expect(await fs.readFile(registryPath, 'utf8')).toBe(JSON.stringify([other], null, 2));
  });
});
