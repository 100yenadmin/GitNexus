import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computePreservationPlan,
  derivePreservationChunkIndices,
  preservationPreviewCommand,
} from '../../src/cli/preservation-preview-cli.js';
import { preservationApplyCommand } from '../../src/cli/preservation-apply-cli.js';
import * as git from '../../src/storage/git.js';
import * as repoManager from '../../src/storage/repo-manager.js';
import * as lbugAdapter from '../../src/core/lbug/lbug-adapter.js';
import * as embeddingPipeline from '../../src/core/embeddings/embedding-pipeline.js';
import * as stagedPromotion from '../../src/core/staged-promotion.js';
import { httpEmbeddingProvider } from '../../src/core/embeddings/embedding-identity.js';
import { embeddingAcceptedPayloadDigest } from '../../src/core/embeddings/identity-digest.js';

describe('preservation preview CLI admission', () => {
  const originalExitCode = process.exitCode;
  const tempDirs: string[] = [];

  afterEach(async () => {
    process.exitCode = originalExitCode;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  const createPreservationRepo = async ({
    provider = 'local',
    model = 'Snowflake/snowflake-arctic-embed-xs',
    config,
    checkpoint,
  }: {
    provider?: string;
    model?: string;
    config?: Record<string, unknown>;
    checkpoint?: Record<string, unknown>;
  } = {}) => {
    const repoPath = await mkdtemp(path.join(tmpdir(), 'gitnexus-preservation-'));
    tempDirs.push(repoPath);
    const storagePath = path.join(repoPath, '.gitnexus');
    await mkdir(storagePath);
    await writeFile(path.join(storagePath, 'lbug'), 'provider-free-test-db');
    await writeFile(
      path.join(storagePath, 'gitnexus.json'),
      JSON.stringify({
        repoPath,
        lastCommit: '',
        indexedAt: '2026-08-30T00:00:00.000Z',
        stats: { embeddings: 0 },
        embeddingCheckpoint: {
          at: '2026-08-30T00:00:00.000Z',
          purpose: 'verified-preservation',
          nodesProcessed: 0,
          totalNodes: 0,
          chunksProcessed: 0,
          provider,
          model,
          dimensions: 384,
          pendingNodeIds: [],
          physicalRows: 0,
          validRows: 0,
          recoverableIdentitySha256: 'a'.repeat(64),
          physicalRowsSha256: 'a'.repeat(64),
          ...checkpoint,
        },
      }),
    );
    if (config) await writeFile(path.join(repoPath, '.gitnexusrc'), JSON.stringify(config));
    return repoPath;
  };

  const mockEmptyPreservationDatabase = (physicalRowsSha256 = 'a'.repeat(64)) => {
    vi.spyOn(lbugAdapter, 'withLbugReadOnlyNonRecovering').mockImplementation(
      async (_dbPath, operation) => operation(),
    );
    const inspect = vi.spyOn(lbugAdapter, 'inspectEmbeddingIntegrity').mockResolvedValue({
      tablePresent: true,
      physicalRows: 0,
      validRows: 0,
      recoverableRows: 0,
      emptyIdRows: 0,
      emptyNodeIdRows: 0,
      invalidChunkRows: 0,
      noncanonicalIdRows: 0,
      duplicateIdRows: 0,
      duplicateSemanticRows: 0,
      orphanRows: 0,
      wrongDimensionRows: 0,
      recoverableIdentitySha256: 'a'.repeat(64),
      physicalRowsSha256,
    });
    const scan = vi.spyOn(lbugAdapter, 'scanEmbeddingPreservationRows').mockResolvedValue({
      tablePresent: true,
      physicalRows: 0,
      acceptedRows: 0,
      rejectedRows: 0,
      duplicateIdRows: 0,
      duplicateSemanticRows: 0,
      noncanonicalIdRows: 0,
      emptyIdRows: 0,
      emptyNodeIdRows: 0,
      invalidChunkRows: 0,
      invalidLineRows: 0,
      nonfiniteRows: 0,
      malformedVectorRows: 0,
      wrongDimensionRows: 0,
      missingContentHashRows: 0,
      labelMismatchRows: 0,
      physicalRowsSha256,
      rejectedRowsSha256: 'rejected',
      acceptedPayloadSha256: embeddingAcceptedPayloadDigest([]),
      implicatedOwnerIds: [],
      missingOwnerLabels: [],
    });
    vi.spyOn(embeddingPipeline, 'queryEmbeddableNodes').mockImplementation(async function* () {});
    return { inspect, scan };
  };

  it('uses one chunk for long short labels just like production embedding', async () => {
    const node = {
      id: 'TypeAlias:long',
      name: 'long',
      label: 'TypeAlias',
      filePath: 'types.ts',
      content: 'x'.repeat(1_300),
      startLine: 4,
      endLine: 8,
    };
    const chunkNode = vi.fn(async () => [{ chunkIndex: 1 }]);

    await expect(derivePreservationChunkIndices(node, chunkNode)).resolves.toEqual([0]);
    expect(chunkNode).not.toHaveBeenCalled();
  });

  it('refuses an incomplete preview before repository or provider work', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await preservationPreviewCommand(undefined, {
      preserveVerifiedEmbeddings: true,
      dryRun: true,
    });

    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('requires'));
    expect(stdout).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an auth token before reading repository state', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await preservationPreviewCommand('/definitely/not/a/repository', {
      preserveVerifiedEmbeddings: true,
      dryRun: true,
      json: true,
      staged: true,
      embeddings: true,
      embeddingAuthToken: 'synthetic-test-value',
    });

    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('not accepted'));
    expect(stdout).not.toHaveBeenCalled();
  });

  it.each([
    ['numeric cap', '1'],
    ['zero cap', '0'],
    ['malformed cap', 'not-a-number'],
    ['numeric zero value', 0],
  ])('rejects a valued --embeddings argument before planning (%s)', async (_label, embeddings) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await preservationApplyCommand('/definitely/not/a/repository', {
      preserveVerifiedEmbeddings: true,
      staged: true,
      embeddings,
      planDigest: 'a'.repeat(64),
      maxReembedNodes: '1',
    });

    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('max-reembed-nodes'));
    expect(stdout).not.toHaveBeenCalled();
  });

  it.each([
    ['flat owner', 'main', undefined],
    ['branch slot', 'feature/x', 'feature/x'],
  ])(
    'uses owner-aware placement for an explicit --branch (%s)',
    async (_label, branch, resolvedBranch) => {
      const requestedPath = '/definitely/not/a/repository';
      const resolvePlacement = vi
        .spyOn(repoManager, 'resolveBranchPlacement')
        .mockResolvedValue(resolvedBranch === undefined ? {} : { branch: resolvedBranch });
      const getStorage = vi.spyOn(repoManager, 'getStoragePaths').mockReturnValue({
        storagePath: `${requestedPath}/.gitnexus`,
        lbugPath: `${requestedPath}/.gitnexus/lbug`,
        metaPath: `${requestedPath}/.gitnexus/gitnexus.json`,
      });
      vi.spyOn(repoManager, 'loadMeta').mockResolvedValue(null);
      const hasGit = vi.spyOn(git, 'hasGitDir').mockReturnValue(false);
      const getCommit = vi.spyOn(git, 'getCurrentCommit');
      const getBranch = vi.spyOn(git, 'getCurrentBranch');

      await expect(
        computePreservationPlan(requestedPath, {
          branch,
        }),
      ).rejects.toThrow('canonical metadata');

      expect(hasGit).toHaveBeenCalledWith(requestedPath);
      expect(getCommit).not.toHaveBeenCalled();
      expect(getBranch).not.toHaveBeenCalled();
      expect(resolvePlacement).toHaveBeenCalledWith(requestedPath, branch);
      expect(getStorage).toHaveBeenCalledWith(requestedPath, resolvedBranch);
    },
  );

  it.each(['physicalRows', 'validRows', 'recoverableIdentitySha256', 'physicalRowsSha256'])(
    'refuses a completed checkpoint missing %s before scan, provider, or lock work',
    async (field) => {
      const repoPath = await createPreservationRepo({ checkpoint: { [field]: undefined } });
      const { scan } = mockEmptyPreservationDatabase();
      const lock = vi.spyOn(stagedPromotion, 'withAnalyzeOwnershipLock');
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await preservationPreviewCommand(repoPath, {
        preserveVerifiedEmbeddings: true,
        dryRun: true,
        json: true,
        staged: true,
        embeddings: true,
        skipGit: true,
      });

      expect(process.exitCode).toBe(1);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('explicitly marked'));
      expect(scan).not.toHaveBeenCalled();
      expect(lock).not.toHaveBeenCalled();
    },
  );

  it('refuses a non-terminal compatibility checkpoint without durable row proof', async () => {
    const repoPath = await createPreservationRepo({
      checkpoint: {
        nodesProcessed: 1,
        totalNodes: 2,
        physicalRows: undefined,
        validRows: undefined,
        recoverableIdentitySha256: undefined,
        physicalRowsSha256: undefined,
      },
    });
    const { scan } = mockEmptyPreservationDatabase();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await preservationPreviewCommand(repoPath, {
      preserveVerifiedEmbeddings: true,
      dryRun: true,
      json: true,
      staged: true,
      embeddings: true,
      skipGit: true,
    });

    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('explicitly marked'));
    expect(scan).not.toHaveBeenCalled();
  });

  it('refuses an unmarked ordinary terminal checkpoint before scan or lock work', async () => {
    const repoPath = await createPreservationRepo({ checkpoint: { purpose: undefined } });
    const { scan } = mockEmptyPreservationDatabase();
    const lock = vi.spyOn(stagedPromotion, 'withAnalyzeOwnershipLock');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await preservationPreviewCommand(repoPath, {
      preserveVerifiedEmbeddings: true,
      dryRun: true,
      json: true,
      staged: true,
      embeddings: true,
      skipGit: true,
    });

    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('explicitly marked'));
    expect(scan).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
  });

  it('does not inherit a real .git identity when --skip-git is set', async () => {
    const requestedPath = '/definitely/not/a/repository';
    const resolvePlacement = vi.spyOn(repoManager, 'resolveBranchPlacement').mockResolvedValue({});
    const getStorage = vi.spyOn(repoManager, 'getStoragePaths').mockReturnValue({
      storagePath: `${requestedPath}/.gitnexus`,
      lbugPath: `${requestedPath}/.gitnexus/lbug`,
      metaPath: `${requestedPath}/.gitnexus/gitnexus.json`,
    });
    vi.spyOn(repoManager, 'loadMeta').mockResolvedValue(null);
    const hasGit = vi.spyOn(git, 'hasGitDir').mockReturnValue(true);
    const getCommit = vi.spyOn(git, 'getCurrentCommit');
    const getBranch = vi.spyOn(git, 'getCurrentBranch');

    await expect(
      computePreservationPlan(requestedPath, {
        branch: 'main',
        skipGit: true,
      }),
    ).rejects.toThrow('canonical metadata');

    expect(hasGit).not.toHaveBeenCalled();
    expect(getCommit).not.toHaveBeenCalled();
    expect(getBranch).not.toHaveBeenCalled();
    expect(resolvePlacement).toHaveBeenCalledWith(requestedPath, 'main');
    expect(getStorage).toHaveBeenCalledWith(requestedPath, undefined);
  });

  it('uses .gitnexusrc embedding identity without provider construction or credentials', async () => {
    const endpoint = 'https://synthetic.invalid/v1';
    const model = 'synthetic-model';
    const repoPath = await createPreservationRepo({
      provider: httpEmbeddingProvider(endpoint),
      model,
      config: { embeddingBaseUrl: endpoint, embeddingModel: model },
    });
    mockEmptyPreservationDatabase();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const context = await computePreservationPlan(repoPath, { skipGit: true });

    expect(context.plan.embedding).toMatchObject({
      provider: httpEmbeddingProvider(endpoint),
      model,
      transport: 'http',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['preview', 'apply'])(
    'refuses %s when completed-checkpoint vector bytes differ before scan, lock, or provider work',
    async (mode) => {
      const repoPath = await createPreservationRepo();
      const { scan } = mockEmptyPreservationDatabase('b'.repeat(64));
      const lock = vi.spyOn(stagedPromotion, 'withAnalyzeOwnershipLock');
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      if (mode === 'preview') {
        await preservationPreviewCommand(repoPath, {
          preserveVerifiedEmbeddings: true,
          dryRun: true,
          json: true,
          staged: true,
          embeddings: true,
          skipGit: true,
        });
      } else {
        await preservationApplyCommand(repoPath, {
          preserveVerifiedEmbeddings: true,
          staged: true,
          embeddings: true,
          planDigest: 'c'.repeat(64),
          maxReembedNodes: '1',
          skipGit: true,
        });
      }

      expect(process.exitCode).toBe(1);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('durable identity'));
      expect(scan).not.toHaveBeenCalled();
      expect(lock).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('retains a completed terminal embedding checkpoint through promotion', async () => {
    const repoPath = await createPreservationRepo();
    mockEmptyPreservationDatabase();
    const expectedDigest = (await computePreservationPlan(repoPath, { skipGit: true })).plan
      .planDigest;
    vi.spyOn(stagedPromotion, 'withAnalyzeOwnershipLock').mockImplementation(
      async (_storagePath, operation) => operation(),
    );
    vi.spyOn(stagedPromotion, 'hasPendingPromotion').mockResolvedValue(false);
    vi.spyOn(stagedPromotion, 'inspectStagedWorkspaceSource').mockResolvedValue({
      exists: false,
      matchesSource: false,
    });
    vi.spyOn(stagedPromotion, 'prepareStagedWorkspace').mockResolvedValue({
      resumed: false,
      generationId: 'synthetic-generation',
    });
    vi.spyOn(lbugAdapter, 'withLbugDb').mockImplementation(async (_dbPath, operation) =>
      operation(),
    );
    vi.spyOn(lbugAdapter, 'closeLbug').mockResolvedValue(undefined);
    vi.spyOn(lbugAdapter, 'recreateCodeEmbeddingTable').mockResolvedValue(undefined);
    vi.spyOn(embeddingPipeline, 'batchInsertEmbeddings').mockResolvedValue(undefined);
    vi.spyOn(embeddingPipeline, 'runEmbeddingPipeline').mockResolvedValue({
      nodesProcessed: 0,
      chunksProcessed: 0,
      vectorIndexReady: false,
      semanticMode: 'exact-scan',
    });
    const saveMeta = vi.spyOn(repoManager, 'saveMeta').mockResolvedValue(undefined);
    vi.spyOn(repoManager, 'registerRepo').mockResolvedValue('repository');
    let promotedStagedMetaDir: string | undefined;
    const promote = vi
      .spyOn(stagedPromotion, 'promoteStagedGeneration')
      .mockImplementation(async (paths, commitMetadataAndRegistry) => {
        promotedStagedMetaDir = paths.stagedMetaDir;
        const stagedMeta = saveMeta.mock.calls.find(
          ([metaDir, meta]) =>
            metaDir === paths.stagedMetaDir && meta.embeddingCheckpoint !== undefined,
        )?.[1];
        if (!stagedMeta) throw new Error('synthetic staged metadata was not saved');
        await commitMetadataAndRegistry(stagedMeta);
        return { projectName: 'repository', recovered: false };
      });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await preservationApplyCommand(repoPath, {
      preserveVerifiedEmbeddings: true,
      staged: true,
      embeddings: true,
      planDigest: expectedDigest,
      maxReembedNodes: '1',
      skipGit: true,
    });

    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('Preservation repair promoted'));
    expect(promote).toHaveBeenCalledOnce();
    const stagedMeta = saveMeta.mock.calls.find(
      ([metaDir, meta]) =>
        metaDir === promotedStagedMetaDir && meta.embeddingCheckpoint !== undefined,
    )?.[1];
    expect(stagedMeta?.embeddingCheckpoint).toMatchObject({
      purpose: 'verified-preservation',
      nodesProcessed: 0,
      totalNodes: 0,
      chunksProcessed: 0,
      provider: 'local',
      model: 'Snowflake/snowflake-arctic-embed-xs',
      dimensions: 384,
      pendingNodeIds: [],
      physicalRows: 0,
      validRows: 0,
      recoverableIdentitySha256: 'a'.repeat(64),
      physicalRowsSha256: 'a'.repeat(64),
    });
  });

  it('dispatches preservation apply without loading the ordinary analyzer', async () => {
    const apply = vi.fn(async () => undefined);
    const analyze = vi.fn(async () => undefined);
    vi.doMock('../../src/cli/preservation-apply-cli.js', () => ({
      preservationApplyCommand: apply,
    }));
    vi.doMock('../../src/cli/analyze.js', () => ({ analyzeCommand: analyze }));
    vi.resetModules();
    const { analyzeAction } = await import('../../src/cli/analyze-action.js');

    const options = {
      preserveVerifiedEmbeddings: true,
      staged: true,
      embeddings: true,
      planDigest: 'a'.repeat(64),
      maxReembedNodes: '1',
    };
    await analyzeAction('/repo', options);

    expect(apply).toHaveBeenCalledWith('/repo', options);
    expect(analyze).not.toHaveBeenCalled();
    vi.doUnmock('../../src/cli/preservation-apply-cli.js');
    vi.doUnmock('../../src/cli/analyze.js');
    vi.resetModules();
  });
});
