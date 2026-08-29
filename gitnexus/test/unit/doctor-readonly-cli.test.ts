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

  it.each([
    ['malformed', '{', 'malformed'],
    ['non-array', '{}', 'not-array'],
    ['null element', '[null]', 'malformed'],
    ['missing fields', '[{}]', 'malformed'],
    [
      'non-string field',
      '[{"name":7,"path":"x","storagePath":"x","indexedAt":"x","lastCommit":"x"}]',
      'malformed',
    ],
  ] as const)('fails closed for a %s registry', async (_label, contents, reason) => {
    await fs.writeFile(path.join(home.dbPath, 'registry.json'), contents);

    const result = runDoctor(['--registry', '--json']);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: 'registry',
      readOnly: true,
      registryRead: { status: 'failed', reason },
      summary: { entries: 0 },
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(home.dbPath);
    if (contents !== '{' && contents !== '{}') {
      expect(`${result.stdout}${result.stderr}`).not.toContain(contents);
    }
  });

  it('fails closed for an unreadable registry', async () => {
    await fs.mkdir(path.join(home.dbPath, 'registry.json'));
    const unreadable = runDoctor(['--registry', '--json']);
    expect(unreadable.status).toBe(1);
    expect(JSON.parse(unreadable.stdout)).toMatchObject({
      registryRead: { status: 'failed', reason: 'unreadable' },
      summary: { entries: 0 },
    });
    expect(`${unreadable.stdout}${unreadable.stderr}`).not.toContain(home.dbPath);
  });

  it('keeps a valid empty registry available', async () => {
    await fs.writeFile(path.join(home.dbPath, 'registry.json'), '[]');
    const result = runDoctor(['--registry', '--json']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      registryRead: { status: 'available' },
      summary: { entries: 0 },
    });
  });

  it('treats a missing registry as a healthy empty installation', () => {
    const result = runDoctor(['--registry', '--json']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      registryRead: { status: 'available' },
      summary: { entries: 0 },
    });
  });

  it('treats an ENOTDIR registry path as a healthy empty installation', async () => {
    const nonDirectoryHome = path.join(home.dbPath, 'not-a-directory');
    await fs.writeFile(nonDirectoryHome, '');

    const result = runDoctor(['--registry', '--json'], { GITNEXUS_HOME: nonDirectoryHome });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      registryRead: { status: 'available' },
      summary: { entries: 0 },
    });
  });

  it('diagnoses malformed HTTP dimensions through registry Doctor JSON', async () => {
    const repoPath = path.join(home.dbPath, 'repo');
    await fs.writeFile(
      path.join(home.dbPath, 'registry.json'),
      JSON.stringify([
        {
          name: 'repo',
          path: repoPath,
          storagePath: path.join(repoPath, '.gitnexus'),
          indexedAt: '2026-07-20T00:00:00.000Z',
          lastCommit: 'a'.repeat(40),
          stats: { embeddings: 1 },
        },
      ]),
    );
    for (const [embeddingUrl, dimensions] of [
      ['https://embedding.example/v1', '384abc'],
      ['https://embedding.example/v1?secret=1', '384'],
      ['https://embedding.example/v1#frag', '384'],
      ['https://embedding.example/v1?', '384'],
      ['https://embedding.example/v1#', '384'],
    ] as const) {
      const result = runDoctor(['--registry', '--json'], {
        GITNEXUS_EMBEDDING_URL: embeddingUrl,
        GITNEXUS_EMBEDDING_MODEL: 'test-model',
        GITNEXUS_EMBEDDING_DIMS: dimensions,
      });
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout);
      expect(report.entries[0].health.reasons).toContain('embedding-query-http-config-invalid');
      expect(`${result.stdout}${result.stderr}`).not.toContain('embedding.example');
      expect(`${result.stdout}${result.stderr}`).not.toContain('test-model');
    }
  });
});
