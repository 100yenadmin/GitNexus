import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computePreservationPlan,
  derivePreservationChunkIndices,
  preservationPreviewCommand,
} from '../../src/cli/preservation-preview-cli.js';
import * as git from '../../src/storage/git.js';
import * as repoManager from '../../src/storage/repo-manager.js';

describe('preservation preview CLI admission', () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

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
