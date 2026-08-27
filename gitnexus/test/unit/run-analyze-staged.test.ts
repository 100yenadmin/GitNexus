import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fsSync from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { getStoragePaths, loadMeta, saveMeta } from '../../src/storage/repo-manager.js';
import {
  getStagedAnalyzePaths,
  prepareStagedWorkspace,
  promoteStagedGeneration,
  withAnalyzeOwnershipLock,
  type RepositorySourceIdentity,
} from '../../src/core/staged-promotion.js';
import { EMBEDDING_DIMS } from '../../src/core/lbug/schema.js';

const tempDirs: string[] = [];

const repositoryIdentity = (repo: string): RepositorySourceIdentity => ({
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  branch:
    execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim() ||
    null,
});

describe('runFullAnalysis --staged', () => {
  let priorHome: string | undefined;
  let priorInstallPolicy: string | undefined;
  let priorEmbeddingUrl: string | undefined;
  let priorEmbeddingModel: string | undefined;
  let priorEmbeddingDims: string | undefined;

  beforeEach(() => {
    priorHome = process.env.GITNEXUS_HOME;
    priorInstallPolicy = process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
    priorEmbeddingUrl = process.env.GITNEXUS_EMBEDDING_URL;
    priorEmbeddingModel = process.env.GITNEXUS_EMBEDDING_MODEL;
    priorEmbeddingDims = process.env.GITNEXUS_EMBEDDING_DIMS;
    process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = 'never';
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = priorHome;
    if (priorInstallPolicy === undefined) delete process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
    else process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = priorInstallPolicy;
    if (priorEmbeddingUrl === undefined) delete process.env.GITNEXUS_EMBEDDING_URL;
    else process.env.GITNEXUS_EMBEDDING_URL = priorEmbeddingUrl;
    if (priorEmbeddingModel === undefined) delete process.env.GITNEXUS_EMBEDDING_MODEL;
    else process.env.GITNEXUS_EMBEDDING_MODEL = priorEmbeddingModel;
    if (priorEmbeddingDims === undefined) delete process.env.GITNEXUS_EMBEDDING_DIMS;
    else process.env.GITNEXUS_EMBEDDING_DIMS = priorEmbeddingDims;
    vi.unstubAllGlobals();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it('rejects incremental-only drop before creating staged storage', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-staged-conflict-'));
    tempDirs.push(repo);
    await fs.writeFile(path.join(repo, 'index.ts'), 'export const value = 1;\n');
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['add', 'index.ts'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'initial'],
      { cwd: repo },
    );

    await expect(
      runFullAnalysis(
        repo,
        { staged: true, incrementalOnly: true, dropEmbeddings: true },
        { onProgress: () => {} },
      ),
    ).rejects.toThrow(/cannot combine `--incremental-only` with `--drop-embeddings`/i);
    await expect(fs.access(path.join(repo, '.gitnexus'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a full staged write when metadata hides physical embeddings', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-staged-no-restore-'));
    tempDirs.push(repo);
    process.env.GITNEXUS_HOME = path.join(repo, '.registry-home');
    await fs.writeFile(path.join(repo, 'index.ts'), 'export const value = 1;\n');
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync('git', ['add', 'index.ts'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'initial'],
      { cwd: repo },
    );

    await runFullAnalysis(repo, { skipAgentsMd: true, skipSkills: true }, { onProgress: () => {} });
    const canonical = getStoragePaths(repo);
    const meta = await loadMeta(canonical.storagePath);
    if (!meta) throw new Error('expected canonical metadata');
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.initLbug(canonical.lbugPath);
    try {
      const [owner] = await adapter.executeQuery(
        'MATCH (n) WHERE n.id IS NOT NULL RETURN n.id AS id LIMIT 1',
      );
      const nodeId = String(owner?.id ?? owner?.[0] ?? '');
      if (!nodeId) throw new Error('expected a graph node for the embedding fixture');
      await adapter.executeWithReusedStatement(
        'CREATE (e:CodeEmbedding {id: $id, nodeId: $nodeId, chunkIndex: $chunkIndex, ' +
          'startLine: 1, endLine: 1, embedding: $embedding, contentHash: $contentHash})',
        [
          {
            id: `${nodeId}:0`,
            nodeId,
            chunkIndex: 0,
            embedding: new Array(EMBEDDING_DIMS).fill(0.25),
            contentHash: 'hidden-by-stale-meta',
          },
        ],
      );
    } finally {
      await adapter.closeLbug();
    }
    await saveMeta(canonical.storagePath, {
      ...meta,
      // Reproduce the observed stale-metadata shape: the database has one
      // physical vector while metadata claims zero.
      stats: { ...meta.stats, embeddings: 0 },
    });
    const before = await fs.stat(canonical.lbugPath);

    await expect(
      runFullAnalysis(
        repo,
        { staged: true, force: true, skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {} },
      ),
    ).rejects.toThrow(/requires explicit `--drop-embeddings`/);

    const after = await fs.stat(canonical.lbugPath);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('regenerates staged embeddings from an empty isolated table when drop is explicit', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-staged-clean-embedding-'));
    tempDirs.push(repo);
    process.env.GITNEXUS_HOME = path.join(repo, '.registry-home');
    process.env.GITNEXUS_EMBEDDING_URL = 'http://test.invalid/v1';
    process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
    process.env.GITNEXUS_EMBEDDING_DIMS = String(EMBEDDING_DIMS);
    const vector = new Array(EMBEDDING_DIMS).fill(0.125);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { input?: unknown[] };
        const count = Array.isArray(body.input) ? body.input.length : 1;
        return {
          ok: true,
          json: async () => ({
            data: Array.from({ length: count }, () => ({ embedding: vector })),
          }),
        };
      }),
    );
    await fs.writeFile(
      path.join(repo, 'index.ts'),
      'export function cleanStageEmbedding() { return 1; }\n',
    );
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync('git', ['add', 'index.ts'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'initial'],
      { cwd: repo },
    );

    await runFullAnalysis(repo, { skipAgentsMd: true, skipSkills: true }, { onProgress: () => {} });
    const canonical = getStoragePaths(repo);
    const meta = await loadMeta(canonical.storagePath);
    if (!meta) throw new Error('expected canonical metadata');
    await saveMeta(canonical.storagePath, {
      ...meta,
      stats: { ...meta.stats, embeddings: 1 },
    });

    await runFullAnalysis(
      repo,
      {
        staged: true,
        embeddings: true,
        dropEmbeddings: true,
        skipAgentsMd: true,
        skipSkills: true,
      },
      { onProgress: () => {} },
    );

    const finalMeta = await loadMeta(canonical.storagePath);
    expect(finalMeta?.stats?.embeddings).toBeGreaterThan(0);
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.initLbugReadOnlyNonRecovering(canonical.lbugPath);
    try {
      await expect(adapter.inspectEmbeddingIntegrity()).resolves.toMatchObject({
        physicalRows: finalMeta?.stats?.embeddings,
        emptyIdRows: 0,
        emptyNodeIdRows: 0,
        invalidChunkRows: 0,
        noncanonicalIdRows: 0,
        duplicateIdRows: 0,
        duplicateSemanticRows: 0,
        orphanRows: 0,
        wrongDimensionRows: 0,
      });
    } finally {
      await adapter.closeLbug();
    }
    const staged = getStagedAnalyzePaths(canonical.lbugPath, canonical.storagePath);
    await expect(fs.access(staged.stageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);

  it('never resumes a staged embedding checkpoint without an explicit clean rebuild', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-staged-checkpoint-refusal-'));
    tempDirs.push(repo);
    process.env.GITNEXUS_HOME = path.join(repo, '.registry-home');
    await fs.writeFile(path.join(repo, 'index.ts'), 'export const value = 1;\n');
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync('git', ['add', 'index.ts'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'initial'],
      { cwd: repo },
    );

    await runFullAnalysis(repo, { skipAgentsMd: true, skipSkills: true }, { onProgress: () => {} });
    const canonical = getStoragePaths(repo);
    const canonicalMeta = await loadMeta(canonical.storagePath);
    if (!canonicalMeta) throw new Error('expected canonical metadata');
    const canonicalBefore = await fs.stat(canonical.lbugPath);
    const staged = getStagedAnalyzePaths(canonical.lbugPath, canonical.storagePath);
    await prepareStagedWorkspace(staged, canonicalMeta, repositoryIdentity(repo));
    await saveMeta(staged.stagedMetaDir, {
      ...canonicalMeta,
      embeddingCheckpoint: {
        at: new Date().toISOString(),
        nodesProcessed: 0,
        totalNodes: 1,
        chunksProcessed: 0,
        model: 'test-model',
        dimensions: EMBEDDING_DIMS,
        pendingNodeIds: ['Function:pending'],
      },
    });
    const stagedBefore = await fs.stat(staged.stagedLbugPath);
    const stagedMetaPath = path.join(staged.stagedMetaDir, 'gitnexus.json');
    const stagedMetaBefore = await fs.readFile(stagedMetaPath);
    await fs.writeFile(path.join(repo, 'index.ts'), 'export const value = 2;\n');
    execFileSync('git', ['add', 'index.ts'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'advance-source'],
      { cwd: repo },
    );

    await expect(
      runFullAnalysis(
        repo,
        { staged: true, embeddings: true, skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {} },
      ),
    ).rejects.toThrow(/unjournaled staged generation already exists/i);
    expect((await fs.stat(canonical.lbugPath)).ino).toBe(canonicalBefore.ino);
    const stagedAfter = await fs.stat(staged.stagedLbugPath);
    expect(stagedAfter.ino).toBe(stagedBefore.ino);
    expect(stagedAfter.mtimeMs).toBe(stagedBefore.mtimeMs);
    await expect(fs.readFile(stagedMetaPath)).resolves.toEqual(stagedMetaBefore);
  });

  it('keeps the canonical DB inode unchanged until validated promotion', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-staged-run-'));
    tempDirs.push(repo);
    process.env.GITNEXUS_HOME = path.join(repo, '.registry-home');
    await fs.writeFile(path.join(repo, 'index.ts'), 'export const value = 1;\n');
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync('git', ['add', 'index.ts'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'initial'],
      { cwd: repo },
    );

    await runFullAnalysis(repo, { skipAgentsMd: true, skipSkills: true }, { onProgress: () => {} });
    const canonical = getStoragePaths(repo);
    const before = fsSync.statSync(canonical.lbugPath);

    await fs.writeFile(path.join(repo, 'index.ts'), 'export const value = 2;\n');
    execFileSync('git', ['add', 'index.ts'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'change'],
      { cwd: repo },
    );

    let sawPrePromotion = false;
    const result = await runFullAnalysis(
      repo,
      { staged: true, dropEmbeddings: true, skipAgentsMd: true, skipSkills: true },
      {
        onProgress: (_phase, percent) => {
          if (percent >= 99) return;
          sawPrePromotion = true;
          const during = fsSync.statSync(canonical.lbugPath);
          expect(during.ino).toBe(before.ino);
          expect(during.mtimeMs).toBe(before.mtimeMs);
        },
      },
    );

    expect(sawPrePromotion).toBe(true);
    expect(result.alreadyUpToDate).not.toBe(true);
    const after = fsSync.statSync(canonical.lbugPath);
    expect(after.ino).not.toBe(before.ino);
    const finalMeta = await loadMeta(canonical.storagePath);
    expect(finalMeta?.lastCommit).toBe(
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    );

    const staged = getStagedAnalyzePaths(canonical.lbugPath, canonical.storagePath);
    await expect(fs.access(staged.stageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(staged.backupLbugPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(staged.journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rolls back a missing canonical pathname before refusing a changed branch', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-staged-recover-'));
    tempDirs.push(repo);
    process.env.GITNEXUS_HOME = path.join(repo, '.registry-home');
    await fs.writeFile(path.join(repo, 'index.ts'), 'export const value = 1;\n');
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync('git', ['add', 'index.ts'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'initial'],
      { cwd: repo },
    );
    const originalBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    await runFullAnalysis(repo, { skipAgentsMd: true, skipSkills: true }, { onProgress: () => {} });

    const canonical = getStoragePaths(repo);
    const canonicalMeta = await loadMeta(canonical.storagePath);
    if (!canonicalMeta) throw new Error('expected canonical metadata');
    const staged = getStagedAnalyzePaths(canonical.lbugPath, canonical.storagePath);
    await prepareStagedWorkspace(staged, canonicalMeta, repositoryIdentity(repo));
    await saveMeta(staged.stagedMetaDir, {
      ...canonicalMeta,
      indexedAt: '2026-07-20T12:00:00.000Z',
    });
    await expect(
      promoteStagedGeneration(staged, async () => 'repo', {
        afterBoundary: (boundary) => {
          if (boundary === 'old-backed-up') throw new Error('simulated crash');
        },
      }),
    ).rejects.toThrow('simulated crash');
    await expect(fs.access(canonical.lbugPath)).rejects.toMatchObject({ code: 'ENOENT' });
    execFileSync('git', ['switch', '-c', 'other'], { cwd: repo, stdio: 'pipe' });

    await expect(
      runFullAnalysis(
        repo,
        { staged: true, branch: originalBranch, skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {} },
      ),
    ).rejects.toThrow('repository HEAD or branch changed');
    await expect(fs.access(canonical.lbugPath)).resolves.toBeUndefined();
    await expect(fs.access(staged.journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses an unjournaled completed stage instead of auto-promoting it', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-staged-prejournal-'));
    tempDirs.push(repo);
    const registryHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-staged-registry-'));
    tempDirs.push(registryHome);
    process.env.GITNEXUS_HOME = registryHome;
    await fs.writeFile(path.join(repo, 'index.ts'), 'export const value = 1;\n');
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync('git', ['add', 'index.ts'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'initial'],
      { cwd: repo },
    );
    await runFullAnalysis(repo, { skipAgentsMd: true, skipSkills: true }, { onProgress: () => {} });

    const canonical = getStoragePaths(repo);
    const canonicalMeta = await loadMeta(canonical.storagePath);
    if (!canonicalMeta) throw new Error('expected canonical metadata');
    const canonicalBefore = await fs.stat(canonical.lbugPath);
    const staged = getStagedAnalyzePaths(canonical.lbugPath, canonical.storagePath);
    await prepareStagedWorkspace(staged, canonicalMeta, repositoryIdentity(repo));
    await saveMeta(staged.stagedMetaDir, {
      ...canonicalMeta,
      indexedAt: '2026-07-20T12:00:00.000Z',
    });
    const stagedBefore = await fs.stat(staged.stagedLbugPath);

    await expect(
      runFullAnalysis(
        repo,
        { staged: true, force: true, skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {} },
      ),
    ).rejects.toThrow(/unjournaled staged generation already exists/i);

    expect((await fs.stat(canonical.lbugPath)).ino).toBe(canonicalBefore.ino);
    expect((await fs.stat(staged.stagedLbugPath)).ino).toBe(stagedBefore.ino);
    expect((await loadMeta(staged.stagedMetaDir))?.indexedAt).toBe('2026-07-20T12:00:00.000Z');
    await expect(fs.access(staged.stageRoot)).resolves.toBeUndefined();
    await expect(fs.access(staged.journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a dirty completed stage with embeddings before snapshot preservation', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-staged-dirty-force-'));
    tempDirs.push(repo);
    process.env.GITNEXUS_HOME = path.join(repo, '.registry-home');
    await fs.writeFile(path.join(repo, 'index.ts'), 'export const value = 1;\n');
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync('git', ['add', 'index.ts'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'initial'],
      { cwd: repo },
    );
    await runFullAnalysis(repo, { skipAgentsMd: true, skipSkills: true }, { onProgress: () => {} });

    const canonical = getStoragePaths(repo);
    const canonicalMeta = await loadMeta(canonical.storagePath);
    if (!canonicalMeta) throw new Error('expected canonical metadata');
    const staged = getStagedAnalyzePaths(canonical.lbugPath, canonical.storagePath);
    await prepareStagedWorkspace(staged, canonicalMeta, repositoryIdentity(repo));
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.initLbug(staged.stagedLbugPath);
    try {
      const [owner] = await adapter.executeQuery(
        'MATCH (n) WHERE n.id IS NOT NULL RETURN n.id AS id LIMIT 1',
      );
      const nodeId = String(owner?.id ?? owner?.[0] ?? '');
      if (!nodeId) throw new Error('expected a graph node for the embedding fixture');
      await adapter.executeWithReusedStatement(
        'CREATE (e:CodeEmbedding {id: $id, nodeId: $nodeId, chunkIndex: $chunkIndex, ' +
          'startLine: 1, endLine: 1, embedding: $embedding, contentHash: $contentHash})',
        [
          {
            id: `${nodeId}:0`,
            nodeId,
            chunkIndex: 0,
            embedding: new Array(EMBEDDING_DIMS).fill(0.25),
            contentHash: 'dirty-completed-stage',
          },
        ],
      );
    } finally {
      await adapter.closeLbug();
    }
    const completedAt = '2026-07-20T12:00:00.000Z';
    await saveMeta(staged.stagedMetaDir, {
      ...canonicalMeta,
      indexedAt: completedAt,
      stats: { ...canonicalMeta.stats, embeddings: 1 },
    });
    const before = await fs.stat(staged.stagedLbugPath);
    await fs.writeFile(path.join(repo, 'index.ts'), 'export const value = 2;\n');

    await expect(
      runFullAnalysis(
        repo,
        { staged: true, force: true, skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {} },
      ),
    ).rejects.toThrow(/unjournaled staged generation already exists/i);

    const after = await fs.stat(staged.stagedLbugPath);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await loadMeta(staged.stagedMetaDir)).toMatchObject({
      indexedAt: completedAt,
      stats: { embeddings: 1 },
    });
    await expect(
      fs.access(path.join(staged.stagedMetaDir, 'embedding-preservation.jsonl')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('replaces rather than promotes a completed stage when drop is explicit', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-staged-completed-drop-'));
    tempDirs.push(repo);
    process.env.GITNEXUS_HOME = path.join(repo, '.registry-home');
    await fs.writeFile(path.join(repo, 'index.ts'), 'export const value = 1;\n');
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync('git', ['add', 'index.ts'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'initial'],
      { cwd: repo },
    );
    await runFullAnalysis(repo, { skipAgentsMd: true, skipSkills: true }, { onProgress: () => {} });

    const canonical = getStoragePaths(repo);
    const canonicalMeta = await loadMeta(canonical.storagePath);
    if (!canonicalMeta) throw new Error('expected canonical metadata');
    const staged = getStagedAnalyzePaths(canonical.lbugPath, canonical.storagePath);
    await prepareStagedWorkspace(staged, canonicalMeta, repositoryIdentity(repo));
    const completedAt = '2026-07-20T12:00:00.000Z';
    await saveMeta(staged.stagedMetaDir, { ...canonicalMeta, indexedAt: completedAt });

    const result = await runFullAnalysis(
      repo,
      {
        staged: true,
        force: true,
        dropEmbeddings: true,
        skipAgentsMd: true,
        skipSkills: true,
      },
      { onProgress: () => {} },
    );

    expect(result.alreadyUpToDate).not.toBe(true);
    expect((await loadMeta(canonical.storagePath))?.indexedAt).not.toBe(completedAt);
    await expect(fs.access(staged.stageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns success after recovering a pending staged promotion without drop', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-staged-recovery-success-'));
    tempDirs.push(repo);
    process.env.GITNEXUS_HOME = path.join(repo, '.registry-home');
    await fs.writeFile(path.join(repo, 'index.ts'), 'export const value = 1;\n');
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync('git', ['add', 'index.ts'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'initial'],
      { cwd: repo },
    );
    await runFullAnalysis(repo, { skipAgentsMd: true, skipSkills: true }, { onProgress: () => {} });

    const canonical = getStoragePaths(repo);
    const canonicalMeta = await loadMeta(canonical.storagePath);
    if (!canonicalMeta) throw new Error('expected canonical metadata');
    const staged = getStagedAnalyzePaths(canonical.lbugPath, canonical.storagePath);
    await prepareStagedWorkspace(staged, canonicalMeta, repositoryIdentity(repo));
    const recoveredAt = '2026-07-20T12:00:00.000Z';
    await saveMeta(staged.stagedMetaDir, { ...canonicalMeta, indexedAt: recoveredAt });
    await expect(
      promoteStagedGeneration(staged, async () => 'repo', {
        afterBoundary: (boundary) => {
          if (boundary === 'old-backed-up') throw new Error('simulated crash');
        },
      }),
    ).rejects.toThrow('simulated crash');
    await fs.rm(path.join(canonical.storagePath, '.gitignore'), { force: true });
    await fs.rm(path.join(repo, 'AGENTS.md'), { force: true });
    await fs.rm(path.join(repo, 'CLAUDE.md'), { force: true });

    const result = await runFullAnalysis(
      repo,
      { staged: true, skipSkills: true },
      { onProgress: () => {} },
    );

    expect(result.recoveredPromotionOnly).toBe(true);
    expect(result.alreadyUpToDate).not.toBe(true);
    expect((await loadMeta(canonical.storagePath))?.indexedAt).toBe(recoveredAt);
    await expect(fs.readFile(path.join(canonical.storagePath, '.gitignore'), 'utf8')).resolves.toBe(
      '*\n',
    );
    await expect(fs.readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8')).resolves.toMatch(
      /\.gitnexus\//,
    );
    await expect(fs.access(path.join(repo, 'AGENTS.md'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(repo, 'CLAUDE.md'))).resolves.toBeUndefined();
    await expect(fs.access(staged.stageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(staged.journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('finishes committed promotion cleanup after the staged metadata directory is gone', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-staged-committed-cleanup-'));
    tempDirs.push(repo);
    process.env.GITNEXUS_HOME = path.join(repo, '.registry-home');
    await fs.writeFile(path.join(repo, 'index.ts'), 'export const value = 1;\n');
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync('git', ['add', 'index.ts'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'initial'],
      { cwd: repo },
    );
    await runFullAnalysis(repo, { skipAgentsMd: true, skipSkills: true }, { onProgress: () => {} });

    const canonical = getStoragePaths(repo);
    const canonicalMeta = await loadMeta(canonical.storagePath);
    if (!canonicalMeta) throw new Error('expected canonical metadata');
    const staged = getStagedAnalyzePaths(canonical.lbugPath, canonical.storagePath);
    await prepareStagedWorkspace(staged, canonicalMeta, repositoryIdentity(repo));
    await saveMeta(staged.stagedMetaDir, canonicalMeta);

    await expect(
      promoteStagedGeneration(
        staged,
        async (meta) => {
          await saveMeta(canonical.storagePath, meta);
          return 'repo';
        },
        {
          afterBoundary: (boundary) => {
            if (boundary === 'metadata/registry-committed') throw new Error('simulated crash');
          },
        },
      ),
    ).rejects.toThrow('simulated crash');
    await fs.rm(staged.stageRoot, { recursive: true, force: true });
    await expect(fs.access(staged.journalPath)).resolves.toBeUndefined();

    await fs.writeFile(path.join(repo, 'index.ts'), 'export const value = 2;\n');
    execFileSync('git', ['add', 'index.ts'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'advanced'],
      { cwd: repo },
    );

    const result = await runFullAnalysis(
      repo,
      { skipAgentsMd: true, skipSkills: true },
      { onProgress: () => {} },
    );

    expect(result.recoveredPromotionOnly).toBe(true);
    expect(result.alreadyUpToDate).not.toBe(true);
    expect((await loadMeta(canonical.storagePath))?.lastCommit).not.toBe(
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    );
    await expect(fs.access(staged.journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(staged.backupLbugPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses malformed staged embeddings while recovering a prepared promotion', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-staged-integrity-'));
    const registryHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-staged-registry-'));
    tempDirs.push(repo, registryHome);
    process.env.GITNEXUS_HOME = registryHome;
    await fs.writeFile(path.join(repo, 'index.ts'), 'export const value = 1;\n');
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync('git', ['add', 'index.ts'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'initial'],
      { cwd: repo },
    );
    await runFullAnalysis(repo, { skipAgentsMd: true, skipSkills: true }, { onProgress: () => {} });

    const canonical = getStoragePaths(repo);
    const canonicalMeta = await loadMeta(canonical.storagePath);
    if (!canonicalMeta) throw new Error('expected canonical metadata');
    const canonicalBefore = await fs.stat(canonical.lbugPath);
    const staged = getStagedAnalyzePaths(canonical.lbugPath, canonical.storagePath);
    await prepareStagedWorkspace(staged, canonicalMeta, repositoryIdentity(repo));
    await saveMeta(staged.stagedMetaDir, {
      ...canonicalMeta,
      indexedAt: '2026-07-22T00:00:00.000Z',
      // Keep the stale count at zero so the pre-promotion scan, rather than
      // cache preservation, is the gate exercised by this fixture.
      stats: { ...canonicalMeta.stats, embeddings: 0 },
    });
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.initLbug(staged.stagedLbugPath);
    try {
      await adapter.executeWithReusedStatement(
        'CREATE (e:CodeEmbedding {id: $id, nodeId: $nodeId, chunkIndex: $chunkIndex, ' +
          'startLine: 1, endLine: 1, embedding: $embedding, contentHash: $contentHash})',
        [
          {
            id: 'malformed:0',
            nodeId: '',
            chunkIndex: 0,
            embedding: new Array(EMBEDDING_DIMS).fill(0),
            contentHash: 'fixture',
          },
        ],
      );
    } finally {
      await adapter.closeLbug();
    }

    await expect(
      promoteStagedGeneration(staged, async () => 'repo', {
        afterBoundary: (boundary) => {
          if (boundary === 'prepared') throw new Error('simulated crash');
        },
      }),
    ).rejects.toThrow('simulated crash');
    await expect(fs.access(staged.journalPath)).resolves.toBeUndefined();

    await expect(
      runFullAnalysis(
        repo,
        { staged: true, skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {} },
      ),
    ).rejects.toThrow(/pending staged promotion candidate.*embedding integrity/i);
    expect((await fs.stat(canonical.lbugPath)).ino).toBe(canonicalBefore.ino);
    await expect(fs.access(staged.journalPath)).resolves.toBeUndefined();
  });

  it('recovers an old-backed-up journal during plain analyze before its fast path', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-plain-recover-'));
    const registryHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-plain-registry-'));
    tempDirs.push(repo, registryHome);
    process.env.GITNEXUS_HOME = registryHome;
    await fs.writeFile(path.join(repo, 'index.ts'), 'export const value = 1;\n');
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync('git', ['add', 'index.ts'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'initial'],
      { cwd: repo },
    );
    await runFullAnalysis(repo, { skipAgentsMd: true, skipSkills: true }, { onProgress: () => {} });

    const canonical = getStoragePaths(repo);
    const canonicalMeta = await loadMeta(canonical.storagePath);
    if (!canonicalMeta) throw new Error('expected canonical metadata');
    const staged = getStagedAnalyzePaths(canonical.lbugPath, canonical.storagePath);
    await prepareStagedWorkspace(staged, canonicalMeta, repositoryIdentity(repo));
    await saveMeta(staged.stagedMetaDir, {
      ...canonicalMeta,
      indexedAt: '2026-07-20T12:00:00.000Z',
    });
    await expect(
      promoteStagedGeneration(staged, async () => 'repo', {
        afterBoundary: (boundary) => {
          if (boundary === 'old-backed-up') throw new Error('simulated crash');
        },
      }),
    ).rejects.toThrow('simulated crash');
    await expect(fs.access(canonical.lbugPath)).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(
      runFullAnalysis(
        repo,
        { incrementalOnly: true, skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {} },
      ),
    ).rejects.toThrow('staged-promotion journal requires recovery');
    await expect(fs.access(canonical.lbugPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(staged.journalPath)).resolves.toBeUndefined();

    const result = await runFullAnalysis(
      repo,
      { skipAgentsMd: true, skipSkills: true },
      { onProgress: () => {} },
    );

    expect(result.recoveredPromotionOnly).toBe(true);
    expect(result.alreadyUpToDate).not.toBe(true);
    expect((await loadMeta(canonical.storagePath))?.branch).toBe('main');
    expect((await loadMeta(canonical.storagePath))?.incrementalInProgress).toBeUndefined();
    await expect(fs.access(canonical.lbugPath)).resolves.toBeUndefined();
    await expect(fs.access(staged.journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes supported ordinary and staged analyzers under branch-summary ownership', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-common-lock-'));
    tempDirs.push(repo);
    process.env.GITNEXUS_HOME = path.join(repo, '.registry-home');
    const storage = getStoragePaths(repo).storagePath;
    let release!: () => void;
    const owner = withAnalyzeOwnershipLock(
      storage,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await vi.waitFor(async () => {
      await expect(fs.access(path.join(storage, 'analyze-staged.lock'))).resolves.toBeUndefined();
    });

    // Production branch summaries are emitted only from runFullAnalysisImpl,
    // and every supported ordinary/staged entry reaches it through this same
    // primary-slot ownership lock. A second analyzer cannot enter the summary
    // delete/register window while the first owns it.
    await expect(runFullAnalysis(repo, {}, { onProgress: () => {} })).rejects.toThrow(
      'Another analyze is active',
    );
    await expect(runFullAnalysis(repo, { staged: true }, { onProgress: () => {} })).rejects.toThrow(
      'Another analyze is active',
    );
    release();
    await owner;
  });
});
