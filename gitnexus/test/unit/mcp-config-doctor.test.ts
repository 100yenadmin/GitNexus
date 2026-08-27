import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildMcpConfigDoctorReport } from '../../src/cli/mcp-config-doctor.js';
import { getGlobalRegistryPath, type RegistryEntry } from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

const entry = (name: string, repoPath: string): RegistryEntry => ({
  name,
  path: repoPath,
  storagePath: path.join(repoPath, '.gitnexus'),
  indexedAt: '2026-07-20T00:00:00.000Z',
  lastCommit: 'a'.repeat(40),
});

const REGISTRY = [
  entry('Alpha', '/secret/registry/alpha'),
  entry('Duplicate', '/secret/registry/duplicate-one'),
  entry('duplicate', '/secret/registry/duplicate-two'),
];

describe('doctor --mcp-config preflight (#127)', () => {
  it('accepts valid and duplicate allowlist entries through the production resolver', async () => {
    await expect(
      buildMcpConfigDoctorReport(
        {
          GITNEXUS_MCP_ALLOWED_REPOS: 'Alpha,/secret/registry/alpha,alpha',
          GITNEXUS_MCP_DEFAULT_REPO: 'Alpha',
        },
        REGISTRY,
      ),
    ).resolves.toEqual({ mode: 'mcp-config', readOnly: true, valid: true });
  });

  it.each([
    [{ GITNEXUS_MCP_ALLOWED_REPOS: 'Alpha,MissingConfiguredSecret' }, [2]],
    [{ GITNEXUS_MCP_ALLOWED_REPOS: 'Alpha,,MissingConfiguredSecret' }, [2, 3]],
    [{ GITNEXUS_MCP_ALLOWED_REPOS: 'Alpha,Alpha,MissingConfiguredSecret' }, [3]],
  ])('reports sanitized degraded coordinates for %#', async (env, entryPositions) => {
    const report = await buildMcpConfigDoctorReport(env, REGISTRY);
    expect(report).toEqual({
      mode: 'mcp-config',
      readOnly: true,
      valid: true,
      degraded: true,
      rejectedEntries: entryPositions.map((entryPosition) => ({
        environmentKey: 'GITNEXUS_MCP_ALLOWED_REPOS',
        entryPosition,
        failureClass: 'invalid',
      })),
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('/secret/registry/');
    expect(serialized).not.toContain('MissingConfiguredSecret');
    expect(serialized).not.toContain('Alpha');
    expect(serialized).not.toContain('Duplicate');
  });

  it.each([
    [{ GITNEXUS_MCP_ALLOWED_REPOS: 'Duplicate' }, 'GITNEXUS_MCP_ALLOWED_REPOS', 1, 'ambiguous'],
    [
      { GITNEXUS_MCP_DEFAULT_REPO: 'MissingConfiguredSecret' },
      'GITNEXUS_MCP_DEFAULT_REPO',
      1,
      'invalid',
    ],
    [
      {
        GITNEXUS_MCP_ALLOWED_REPOS: 'Alpha',
        GITNEXUS_MCP_DEFAULT_REPO: '/secret/registry/duplicate-one',
      },
      'GITNEXUS_MCP_DEFAULT_REPO',
      1,
      'default-outside-allowlist',
    ],
    [
      { OPENCLAW_CODE_INDEX_ALLOWED_REPOS: ' , , ' },
      'OPENCLAW_CODE_INDEX_ALLOWED_REPOS',
      1,
      'invalid',
    ],
  ])(
    'returns only sanitized blocking coordinates for %#',
    async (env, environmentKey, entryPosition, failureClass) => {
      const report = await buildMcpConfigDoctorReport(env, REGISTRY);
      expect(report).toEqual({
        mode: 'mcp-config',
        readOnly: true,
        valid: false,
        environmentKey,
        entryPosition,
        failureClass,
      });
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain('/secret/registry/');
      expect(serialized).not.toContain('MissingConfiguredSecret');
      expect(serialized).not.toContain('Alpha');
      expect(serialized).not.toContain('Duplicate');
    },
  );
});

describe('MCP config doctor is registry-read-only', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let savedHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-mcp-doctor-home-');
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await tmpHome.cleanup();
  });

  it('does not prune, rewrite, or open registry entries while resolving policy', async () => {
    const registryPath = getGlobalRegistryPath();
    const raw = JSON.stringify(REGISTRY, null, 2);
    await fs.writeFile(registryPath, raw, 'utf-8');

    const report = await buildMcpConfigDoctorReport({
      GITNEXUS_MCP_ALLOWED_REPOS: 'MissingConfiguredSecret',
    });

    expect(report.valid).toBe(false);
    expect(await fs.readFile(registryPath, 'utf-8')).toBe(raw);
  });
});
