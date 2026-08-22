import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_SPAWN_PREFIX } from '../helpers/cli-entry.js';
import { createTempDir } from '../helpers/test-db.js';

describe('read-only doctor CLI modes (#127, #133)', () => {
  let home: Awaited<ReturnType<typeof createTempDir>>;

  beforeEach(async () => {
    home = await createTempDir();
  });

  afterEach(async () => {
    await home.cleanup();
  });

  const runDoctor = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [...CLI_SPAWN_PREFIX, 'doctor', ...args], {
      encoding: 'utf8',
      env: { ...process.env, GITNEXUS_HOME: home.dbPath, ...env },
    });

  it('emits only sanitized MCP policy coordinates and exits nonzero when invalid', async () => {
    const secretPath = path.join(home.dbPath, 'secret-registry-repo');
    const configuredSecret = 'MissingConfiguredSecret';
    await fs.writeFile(
      path.join(home.dbPath, 'registry.json'),
      JSON.stringify([
        {
          name: 'KnownSecretAlias',
          path: secretPath,
          storagePath: path.join(secretPath, '.gitnexus'),
          indexedAt: '2026-07-20T00:00:00.000Z',
          lastCommit: 'a'.repeat(40),
        },
      ]),
    );

    const result = runDoctor(['--mcp-config', '--json'], {
      GITNEXUS_MCP_ALLOWED_REPOS: configuredSecret,
      GITNEXUS_MCP_DEFAULT_REPO: undefined,
      OPENCLAW_CODE_INDEX_ALLOWED_REPOS: undefined,
      OPENCLAW_CODE_INDEX_DEFAULT_REPO: undefined,
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      mode: 'mcp-config',
      readOnly: true,
      valid: false,
      environmentKey: 'GITNEXUS_MCP_ALLOWED_REPOS',
      entryPosition: 1,
      failureClass: 'invalid',
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(secretPath);
    expect(`${result.stdout}${result.stderr}`).not.toContain(configuredSecret);
    expect(`${result.stdout}${result.stderr}`).not.toContain('KnownSecretAlias');
  });

  it('exits nonzero with sanitized coordinates when MCP policy is degraded', async () => {
    const secretPath = path.join(home.dbPath, 'secret-registry-repo');
    const configuredSecret = 'MissingConfiguredSecret';
    await fs.writeFile(
      path.join(home.dbPath, 'registry.json'),
      JSON.stringify([
        {
          name: 'KnownSecretAlias',
          path: secretPath,
          storagePath: path.join(secretPath, '.gitnexus'),
          indexedAt: '2026-07-20T00:00:00.000Z',
          lastCommit: 'a'.repeat(40),
        },
      ]),
    );

    const result = runDoctor(['--mcp-config', '--json'], {
      GITNEXUS_MCP_ALLOWED_REPOS: `KnownSecretAlias,${configuredSecret}`,
      GITNEXUS_MCP_DEFAULT_REPO: undefined,
      OPENCLAW_CODE_INDEX_ALLOWED_REPOS: undefined,
      OPENCLAW_CODE_INDEX_DEFAULT_REPO: undefined,
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      mode: 'mcp-config',
      readOnly: true,
      valid: true,
      degraded: true,
      rejectedEntries: [
        {
          environmentKey: 'GITNEXUS_MCP_ALLOWED_REPOS',
          entryPosition: 2,
          failureClass: 'invalid',
        },
      ],
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(secretPath);
    expect(`${result.stdout}${result.stderr}`).not.toContain(configuredSecret);
    expect(`${result.stdout}${result.stderr}`).not.toContain('KnownSecretAlias');
  });

  it('hides registry paths by default and reveals them only with --show-paths', async () => {
    const secretPath = path.join(home.dbPath, 'secret-registry-repo');
    await fs.writeFile(
      path.join(home.dbPath, 'registry.json'),
      JSON.stringify([
        {
          name: 'SafeAlias',
          path: secretPath,
          // Deliberately unsafe: this proves the CLI report does not open an
          // index while still exercising the path-redaction surface.
          storagePath: path.join(home.dbPath, 'unrelated-storage'),
          indexedAt: '2026-07-20T00:00:00.000Z',
          lastCommit: 'a'.repeat(40),
          remoteUrl: 'git@github.com:Owner/Repo.git',
        },
      ]),
    );

    const hidden = runDoctor(['--registry', '--json']);
    expect(hidden.status).toBe(1);
    expect(JSON.parse(hidden.stdout)).toMatchObject({
      mode: 'registry',
      readOnly: true,
      pathsShown: false,
      summary: { unsafeStorageEntries: 1 },
      entries: [
        {
          name: 'SafeAlias',
          storage: { status: 'unsafe' },
          health: { state: 'quarantined', semantic_ready: false },
        },
      ],
    });
    expect(`${hidden.stdout}${hidden.stderr}`).not.toContain(secretPath);

    const human = runDoctor(['--registry']);
    expect(human.status).toBe(1);
    expect(human.stdout).toContain('health quarantined:');
    expect(human.stdout).toContain('health reason unsafe-storage: 1');
    expect(`${human.stdout}${human.stderr}`).not.toContain(secretPath);

    const shown = runDoctor(['--registry', '--json', '--show-paths']);
    expect(shown.status).toBe(1);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      pathsShown: true,
      entries: [{ path: secretPath }],
    });
    expect(shown.stdout).toContain(secretPath);
  });
});
