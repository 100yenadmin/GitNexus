import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDir } from '../helpers/test-db.js';

vi.mock('@ladybugdb/core', () => ({ default: {} }));

describe('LadybugDB maintenance open', () => {
  afterEach(() => {
    vi.doUnmock('../../src/core/lbug/lbug-config.js');
    vi.doUnmock('../../src/core/lbug/sidecar-recovery.js');
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('holds the init lock while running the non-recovering sidecar preflight', async () => {
    const fixture = await createTempDir('gitnexus-maintenance-lock-');
    const dbPath = path.join(fixture.dbPath, 'lbug');
    const lockPath = `${dbPath}.init.lock`;
    await fs.writeFile(dbPath, 'fixture');

    const preflightLbugSidecars = vi.fn(async () => {
      const record = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      expect(record.pid).toBe(process.pid);
      return { kind: 'clean' as const };
    });
    const closeLbugConnection = vi.fn(async () => undefined);

    vi.doMock('../../src/core/lbug/lbug-config.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/core/lbug/lbug-config.js')>()),
      openLbugConnection: vi.fn(async () => ({ db: {}, conn: {} })),
      closeLbugConnection,
    }));
    vi.doMock('../../src/core/lbug/sidecar-recovery.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/core/lbug/sidecar-recovery.js')>()),
      preflightLbugSidecars,
    }));

    try {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      await adapter.initLbugForMaintenance(dbPath);

      expect(preflightLbugSidecars).toHaveBeenCalledWith(dbPath, {
        mode: 'write',
        logger: expect.anything(),
        allowQuarantine: false,
      });
      await expect(fs.access(lockPath)).rejects.toThrow();
      await adapter.closeLbug();
    } finally {
      await fixture.cleanup();
    }
  });

  it('never retries a failed strict read-only preflight with a writable open', async () => {
    const fixture = await createTempDir('gitnexus-maintenance-lock-');
    const dbPath = path.join(fixture.dbPath, 'lbug');
    const lockPath = `${dbPath}.init.lock`;
    await fs.writeFile(dbPath, 'fixture');

    const query = vi.fn(async () => {
      throw new Error('simulated read-only shadow replay requirement');
    });
    const openLbugConnection = vi.fn(async () => ({ db: {}, conn: { query } }));
    const closeLbugConnection = vi.fn(async () => undefined);
    const preflightLbugSidecars = vi.fn(async () => ({ kind: 'clean' as const }));

    vi.doMock('../../src/core/lbug/lbug-config.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/core/lbug/lbug-config.js')>()),
      openLbugConnection,
      closeLbugConnection,
    }));
    vi.doMock('../../src/core/lbug/sidecar-recovery.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/core/lbug/sidecar-recovery.js')>()),
      preflightLbugSidecars,
    }));

    try {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      await expect(adapter.initLbugReadOnlyNonRecovering(dbPath)).rejects.toThrow(
        /simulated read-only shadow replay requirement/i,
      );

      expect(preflightLbugSidecars).toHaveBeenCalledWith(dbPath, {
        mode: 'read-only',
        logger: expect.anything(),
        allowQuarantine: false,
      });
      expect(openLbugConnection).toHaveBeenCalledTimes(1);
      expect(openLbugConnection).toHaveBeenCalledWith(expect.anything(), dbPath, {
        readOnly: true,
        throwOnWalReplayFailure: true,
      });
      expect(closeLbugConnection).toHaveBeenCalledTimes(1);
      await expect(fs.access(lockPath)).rejects.toThrow();
    } finally {
      await fixture.cleanup();
    }
  });

  it('holds the session lock through scoped read-only work and cleanup', async () => {
    const fixture = await createTempDir('gitnexus-maintenance-lock-');
    const firstPath = path.join(fixture.dbPath, 'first-lbug');
    const secondPath = path.join(fixture.dbPath, 'second-lbug');
    await fs.writeFile(firstPath, 'fixture');
    const closed = vi.fn(async (_dbPath: string) => undefined);
    const openLbugConnection = vi.fn(async (_driver: unknown, dbPath: string) => ({
      db: { close: async () => closed(dbPath) },
      conn: {
        query: async () => ({ getAll: async () => [], close: async () => undefined }),
        close: async () => undefined,
      },
    }));

    vi.doMock('../../src/core/lbug/lbug-config.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/core/lbug/lbug-config.js')>()),
      openLbugConnection,
    }));
    vi.doMock('../../src/core/lbug/sidecar-recovery.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/core/lbug/sidecar-recovery.js')>()),
      preflightLbugSidecars: vi.fn(async () => ({ kind: 'clean' as const })),
    }));

    try {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      let releaseCallback!: () => void;
      const callbackGate = new Promise<void>((resolve) => (releaseCallback = resolve));
      const scoped = adapter.withLbugReadOnlyNonRecovering(firstPath, async () => {
        await callbackGate;
        return 'scoped';
      });
      await vi.waitFor(() => expect(openLbugConnection).toHaveBeenCalledOnce());

      const competing = adapter.withLbugDb(
        secondPath,
        async () => expect(closed).toHaveBeenCalledWith(firstPath),
        { readOnly: true },
      );
      expect(openLbugConnection).toHaveBeenCalledTimes(1);
      releaseCallback();
      await expect(scoped).resolves.toBe('scoped');
      await competing;

      closed.mockClear();
      await expect(
        adapter.withLbugReadOnlyNonRecovering(firstPath, async () => {
          throw new Error('callback failed');
        }),
      ).rejects.toThrow('callback failed');
      expect(closed).toHaveBeenCalledWith(firstPath);
    } finally {
      await fixture.cleanup();
    }
  });
});
